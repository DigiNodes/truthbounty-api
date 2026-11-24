import { Logger } from '@nestjs/common';
import { CID } from 'multiformats/cid';
import { verifyCIDIntegrity } from './cid-verifier';
import {
  CircuitState,
  ProviderCircuitBreaker,
} from './ipfs-circuit-breaker';
import { IpfsProvider } from './ipfs-provider.interface';

export type AttemptOutcome =
  | 'verified'
  | 'integrity_mismatch'
  | 'timeout'
  | 'rate_limited'
  | 'redirect_rejected'
  | 'http_error'
  | 'too_large'
  | 'network_error'
  | 'circuit_open';

export interface ProviderAttempt {
  providerId: string;
  outcome: AttemptOutcome;
}

/**
 * Chain-derived context that the retrieved evidence is bound to. All fields
 * are required: a request without full binding fails closed.
 */
export interface EvidenceBinding {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

export interface IpfsFetchRequest {
  cid: string;
  binding: EvidenceBinding;
}

export type UnavailableReason =
  | 'invalid_cid'
  | 'invalid_binding'
  | 'quorum_not_met'
  | 'all_providers_unavailable';

export type IpfsFetchResult =
  | {
      status: 'available';
      /** Canonical CID (normalised string), independent of any gateway URL. */
      cid: string;
      bytes: Uint8Array;
      binding: EvidenceBinding;
      source: 'cache' | 'providers';
      verifiedBy: string[];
      attempts: ProviderAttempt[];
    }
  | {
      status: 'unavailable';
      cid: string | null;
      reason: UnavailableReason;
      binding: EvidenceBinding | null;
      attempts: ProviderAttempt[];
    };

export interface IpfsQuorumOptions {
  /** Number of independently verified provider responses required. */
  quorum: number;
  /** Hard upper bound on provider requests per resolution (failover bound). */
  maxAttempts: number;
  timeoutMs: number;
  maxBytes: number;
  cacheMaxEntries: number;
  breakerFailureThreshold: number;
  breakerCooldownMs: number;
  now?: () => number;
}

export const DEFAULT_IPFS_QUORUM_OPTIONS: IpfsQuorumOptions = {
  quorum: 2,
  maxAttempts: 4,
  timeoutMs: 5000,
  maxBytes: 10 * 1024 * 1024,
  cacheMaxEntries: 256,
  breakerFailureThreshold: 3,
  breakerCooldownMs: 30_000,
};

export type AttemptObserver = (
  event: ProviderAttempt & { cid: string; circuit: CircuitState },
) => void;

/**
 * Resolves evidence bytes for a canonical CID from multiple providers.
 *
 * Guarantees:
 *  - Bytes are only returned (or cached) after their SHA-256 matches the CID.
 *  - The cache is written solely from verified bytes, keyed by canonical CID,
 *    so no single provider can poison it.
 *  - Each provider has its own circuit breaker.
 *  - Failover is bounded by `maxAttempts`; every attempt is observable.
 *  - Unavailability is returned explicitly, never as empty/partial content.
 */
export class IpfsQuorumService {
  private readonly logger = new Logger(IpfsQuorumService.name);
  private readonly options: IpfsQuorumOptions;
  private readonly breakers = new Map<string, ProviderCircuitBreaker>();
  private readonly cache = new Map<string, Uint8Array>();

  constructor(
    private readonly providers: IpfsProvider[],
    options: Partial<IpfsQuorumOptions> = {},
    private readonly observer?: AttemptObserver,
  ) {
    this.options = { ...DEFAULT_IPFS_QUORUM_OPTIONS, ...options };
    if (
      !Number.isInteger(this.options.quorum) ||
      this.options.quorum < 1 ||
      this.options.maxAttempts < this.options.quorum
    ) {
      throw new Error('Invalid IPFS quorum configuration');
    }
    const ids = new Set<string>();
    for (const provider of providers) {
      if (ids.has(provider.id)) {
        throw new Error(`Duplicate IPFS provider id: ${provider.id}`);
      }
      ids.add(provider.id);
      this.breakers.set(
        provider.id,
        new ProviderCircuitBreaker({
          failureThreshold: this.options.breakerFailureThreshold,
          cooldownMs: this.options.breakerCooldownMs,
          now: this.options.now,
        }),
      );
    }
  }

  circuitState(providerId: string): CircuitState | undefined {
    return this.breakers.get(providerId)?.state;
  }

  async fetchValidated(request: IpfsFetchRequest): Promise<IpfsFetchResult> {
    const attempts: ProviderAttempt[] = [];

    if (!this.isValidBinding(request.binding)) {
      return {
        status: 'unavailable',
        cid: null,
        reason: 'invalid_binding',
        binding: null,
        attempts,
      };
    }
    const binding = request.binding;

    const canonicalCid = this.canonicalize(request.cid);
    if (!canonicalCid) {
      return {
        status: 'unavailable',
        cid: null,
        reason: 'invalid_cid',
        binding,
        attempts,
      };
    }

    const cached = this.cache.get(canonicalCid);
    if (cached) {
      return {
        status: 'available',
        cid: canonicalCid,
        bytes: new Uint8Array(cached),
        binding,
        source: 'cache',
        verifiedBy: [],
        attempts,
      };
    }

    const verifiedBy: string[] = [];
    let verifiedBytes: Uint8Array | null = null;
    let launched = 0;
    let cursor = 0;

    while (
      verifiedBy.length < this.options.quorum &&
      launched < this.options.maxAttempts &&
      cursor < this.providers.length
    ) {
      const wanted = Math.min(
        this.options.quorum - verifiedBy.length,
        this.options.maxAttempts - launched,
      );
      const batch: IpfsProvider[] = [];
      while (batch.length < wanted && cursor < this.providers.length) {
        const provider = this.providers[cursor++];
        const breaker = this.breakers.get(provider.id) as ProviderCircuitBreaker;
        if (!breaker.tryAcquire()) {
          this.record(attempts, canonicalCid, provider.id, 'circuit_open');
          continue;
        }
        batch.push(provider);
      }
      launched += batch.length;

      const results = await Promise.all(
        batch.map((provider) => this.attempt(provider, canonicalCid)),
      );
      for (const result of results) {
        this.record(attempts, canonicalCid, result.providerId, result.outcome);
        if (result.outcome === 'verified' && result.bytes) {
          verifiedBy.push(result.providerId);
          verifiedBytes ??= result.bytes;
        }
      }
    }

    if (verifiedBytes && verifiedBy.length >= this.options.quorum) {
      this.storeInCache(canonicalCid, verifiedBytes);
      return {
        status: 'available',
        cid: canonicalCid,
        bytes: new Uint8Array(verifiedBytes),
        binding,
        source: 'providers',
        verifiedBy,
        attempts,
      };
    }

    return {
      status: 'unavailable',
      cid: canonicalCid,
      reason:
        verifiedBy.length === 0 ? 'all_providers_unavailable' : 'quorum_not_met',
      binding,
      attempts,
    };
  }

  private async attempt(
    provider: IpfsProvider,
    cid: string,
  ): Promise<{
    providerId: string;
    outcome: AttemptOutcome;
    bytes?: Uint8Array;
  }> {
    const breaker = this.breakers.get(provider.id) as ProviderCircuitBreaker;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.options.timeoutMs);
    });

    const fail = (outcome: AttemptOutcome) => {
      breaker.recordFailure();
      return { providerId: provider.id, outcome };
    };

    try {
      const response = await Promise.race([
        provider.fetch(cid, {
          signal: controller.signal,
          maxBytes: this.options.maxBytes,
        }),
        timeout,
      ]);

      if (response === 'timeout') return fail('timeout');
      if (response.status === 429) return fail('rate_limited');
      if (response.status >= 300 && response.status < 400) {
        return fail('redirect_rejected');
      }
      if (response.status !== 200) return fail('http_error');
      if (response.bytes.length > this.options.maxBytes) {
        return fail('too_large');
      }

      const bytes = Buffer.from(response.bytes);
      if (!(await verifyCIDIntegrity(bytes, cid))) {
        return fail('integrity_mismatch');
      }
      breaker.recordSuccess();
      return { providerId: provider.id, outcome: 'verified', bytes };
    } catch {
      return fail(controller.signal.aborted ? 'timeout' : 'network_error');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private record(
    attempts: ProviderAttempt[],
    cid: string,
    providerId: string,
    outcome: AttemptOutcome,
  ): void {
    attempts.push({ providerId, outcome });
    const circuit = this.breakers.get(providerId)?.state ?? 'closed';
    if (outcome !== 'verified') {
      this.logger.warn(
        `IPFS provider ${providerId} ${outcome} for ${cid} (circuit=${circuit})`,
      );
    }
    this.observer?.({ providerId, outcome, cid, circuit });
  }

  private storeInCache(cid: string, bytes: Uint8Array): void {
    if (this.cache.size >= this.options.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cid, new Uint8Array(bytes));
  }

  private canonicalize(raw: string): string | null {
    try {
      const parsed = CID.parse(raw);
      return parsed.version === 1 ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  private isValidBinding(binding: EvidenceBinding | undefined): boolean {
    return (
      !!binding &&
      Number.isInteger(binding.chainId) &&
      binding.chainId > 0 &&
      typeof binding.releaseId === 'string' &&
      binding.releaseId.length > 0 &&
      Number.isInteger(binding.deploymentBlock) &&
      binding.deploymentBlock >= 0 &&
      typeof binding.artifactChecksum === 'string' &&
      binding.artifactChecksum.length > 0
    );
  }
}
