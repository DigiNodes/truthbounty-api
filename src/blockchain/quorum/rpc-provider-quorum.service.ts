import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_QUORUM_POLICY,
  DivergenceKind,
  QuorumObservationParams,
  QuorumPolicy,
  QuorumProvider,
  QuorumSignal,
  QuorumVerdict,
} from './interfaces';
import { ProviderDivergenceDetector } from './provider-divergence-detector';
import { ProviderQuarantineStore } from './provider-quarantine.store';

/**
 * RpcProviderQuorumService — V2-BE-051
 *
 * Compares chain-derived observations across the configured RPC providers,
 * applies a bounded and explicit quorum policy, quarantines divergent
 * providers, and fails closed whenever quorum cannot be established.
 *
 * Two lanes:
 *   - eligible providers drive the verdict;
 *   - quarantined providers are still *observed* so recovery can be
 *     granted, but their observations never count toward the verdict
 *     and never re-enter the eligible set on the same poll that releases
 *     them. Recovery requires fresh agreement on a subsequent poll.
 *
 * Read-side only. Never writes CanonicalEvent, never mutates protocol
 * state. Provider identity in logs is always the redacted URL.
 */
@Injectable()
export class RpcProviderQuorumService {
  private readonly logger = new Logger(RpcProviderQuorumService.name);
  private policy: QuorumPolicy;
  private readonly detector = new ProviderDivergenceDetector();

  constructor(private readonly quarantineStore: ProviderQuarantineStore) {
    this.policy = { ...DEFAULT_QUORUM_POLICY };
  }

  setPolicy(policy: Partial<QuorumPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  getPolicy(): Readonly<QuorumPolicy> {
    return this.policy;
  }

  async checkSignal(
    providers: QuorumProvider[],
    signal: QuorumSignal,
    params?: QuorumObservationParams,
  ): Promise<QuorumVerdict> {
    const policy = this.policy;

    const eligible = providers
      .filter((p) => !this.quarantineStore.isQuarantined(p.id, policy))
      .slice(0, policy.maxProviders);

    const quarantined = providers
      .filter((p) => this.quarantineStore.isQuarantined(p.id, policy))
      .slice(0, policy.maxProviders);

    if (eligible.length < policy.minAgreement) {
      this.logger.error(
        `Quorum unavailable for ${signal}: only ${eligible.length} eligible provider(s), ` +
          `need ${policy.minAgreement}`,
      );
      return {
        accepted: false,
        signal,
        agreedProviders: [],
        divergentProviders: eligible.map((p) => ({
          id: p.id,
          sanitizedUrl: p.sanitizedUrl,
          kind: DivergenceKind.ERROR,
          detail: 'insufficient eligible providers',
        })),
        policy,
      };
    }

    const observeAll = async (list: QuorumProvider[]) =>
      Promise.all(
        list.map(async (p) => {
          try {
            const value = await this.withTimeout(
              p.observe(signal, params),
              policy.timeoutMs,
            );
            return { provider: p, value, error: undefined as unknown };
          } catch (error) {
            return { provider: p, value: undefined, error };
          }
        }),
      );

    const [eligibleObs, quarantinedObs] = await Promise.all([
      observeAll(eligible),
      observeAll(quarantined),
    ]);

    const groups = new Map<
      string,
      { value: unknown; providers: QuorumProvider[] }
    >();
    for (const obs of eligibleObs) {
      if (obs.error !== undefined) continue;
      const key =
        typeof obs.value === 'bigint'
          ? `bigint:${obs.value.toString()}`
          : `json:${JSON.stringify(obs.value)}`;
      const bucket = groups.get(key) ?? { value: obs.value, providers: [] };
      bucket.providers.push(obs.provider);
      groups.set(key, bucket);
    }

    let winner:
      | { value: unknown; providers: QuorumProvider[] }
      | undefined;
    for (const g of groups.values()) {
      if (!winner || g.providers.length > winner.providers.length) winner = g;
    }

    const quorumHead =
      signal === QuorumSignal.FINALIZED_HEAD && winner?.value !== undefined
        ? (winner.value as bigint)
        : undefined;

    const agreedProviders: string[] = [];
    const divergentProviders: QuorumVerdict['divergentProviders'] = [];

    for (const obs of eligibleObs) {
      // Value-equal to the winner — definitely agreeing.
      const valueEqual =
        winner !== undefined &&
        obs.error === undefined &&
        this.valuesAgree(obs.value, winner.value);

      if (valueEqual) {
        agreedProviders.push(obs.provider.id);
        continue;
      }

      // Ask the detector. `null` = tolerated (e.g. within
      // maxHeadLagBlocks) → count as agreeing, do NOT quarantine.
      const kind = this.detector.classify({
        provider: obs.provider,
        signal,
        observation: obs.value,
        agreedValue: winner?.value,
        quorumHead,
        maxHeadLagBlocks: policy.maxHeadLagBlocks,
        error: obs.error,
      });

      if (kind === null) {
        agreedProviders.push(obs.provider.id);
        continue;
      }

      divergentProviders.push({
        id: obs.provider.id,
        sanitizedUrl: obs.provider.sanitizedUrl,
        kind,
        detail: obs.error
          ? String(obs.error instanceof Error ? obs.error.message : obs.error)
          : undefined,
      });

      this.quarantineStore.quarantine(
        obs.provider.id,
        obs.provider.sanitizedUrl,
        kind,
      );
    }

    for (const obs of quarantinedObs) {
      if (winner === undefined) continue;

      const kind = this.detector.classify({
        provider: obs.provider,
        signal,
        observation: obs.value,
        agreedValue: winner.value,
        quorumHead,
        maxHeadLagBlocks: policy.maxHeadLagBlocks,
        error: obs.error,
      });

      if (kind !== null) {
        // Genuinely diverging again — reset accumulated fresh agreement.
        this.quarantineStore.resetAgreement(obs.provider.id);
        continue;
      }

      const released = this.quarantineStore.recordAgreement(
        obs.provider.id,
        policy,
      );
      if (released) {
        this.logger.log(
          `Provider ${obs.provider.sanitizedUrl} released — recovery complete`,
        );
      }
    }

    const accepted =
      winner !== undefined && agreedProviders.length >= policy.minAgreement;

    if (accepted) {
      this.logger.debug(
        `Quorum accepted for ${signal}: ${agreedProviders.length}/${eligible.length} agree`,
      );
    } else {
      this.logger.error(
        `Quorum REJECTED for ${signal}: only ${agreedProviders.length} agree, ` +
          `need ${policy.minAgreement}`,
      );
    }

    return {
      accepted,
      value: winner?.value,
      signal,
      agreedProviders,
      divergentProviders,
      policy,
    };
  }

  async checkAll(
    providers: QuorumProvider[],
    params?: QuorumObservationParams,
  ): Promise<Record<QuorumSignal, QuorumVerdict>> {
    const signals: QuorumSignal[] = [
      QuorumSignal.CHAIN_ID,
      QuorumSignal.FINALIZED_HEAD,
      QuorumSignal.BLOCK_HASH,
      QuorumSignal.RECEIPT_STATUS,
      QuorumSignal.CONTRACT_CODE_HASH,
    ];

    const out: Partial<Record<QuorumSignal, QuorumVerdict>> = {};
    for (const signal of signals) {
      out[signal] = await this.checkSignal(providers, signal, params);
    }
    return out as Record<QuorumSignal, QuorumVerdict>;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`RPC call timeout after ${ms}ms`)),
          ms,
        ),
      ),
    ]);
  }

  private valuesAgree(a: unknown, b: unknown): boolean {
    if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
}
