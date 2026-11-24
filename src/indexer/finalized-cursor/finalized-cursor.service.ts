import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Gauge, register } from 'prom-client';
import {
  FINALIZED_CURSOR_CONFIG,
  FinalizedCursorConfig,
  DEFAULT_FRESHNESS_POLICY,
  assertValidBinding,
} from './finalized-cursor.config';
import {
  FINALIZED_CURSOR_STORE,
  FinalizedCursorStore,
  FinalizedCursorTransaction,
} from './finalized-cursor.store';
import {
  ApplyRangeResult,
  CanonicalEvent,
  ChainHeads,
  CursorNotReadyReason,
  FinalizedCursorError,
  FinalizedCursorRecord,
  FinalizedCursorStatus,
  FinalizedRange,
  FreshnessPolicy,
  RecordHeadsResult,
  ReleaseBinding,
} from './finalized-cursor.types';

const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Minimal provider surface (compatible with ethers v6 JsonRpcProvider). */
export interface HeadProvider {
  getNetwork(): Promise<{ chainId: bigint | number }>;
  getBlock(
    tag: 'latest' | 'safe' | 'finalized',
  ): Promise<{ number: number } | null>;
}

/** Applies projection effects inside the cursor transaction. */
export type ProjectionEffects<THandle> = (
  handle: THandle,
  events: readonly CanonicalEvent[],
) => Promise<void>;

function gauge(name: string, help: string, labelNames: string[]): Gauge {
  return (
    (register.getSingleMetric(name) as Gauge | undefined) ??
    new Gauge({ name, help, labelNames })
  );
}

function toSafeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new FinalizedCursorError(
      'INVALID_HEADS',
      'block number exceeds safe range',
    );
  }
  return n;
}

function matchesBinding(
  record: FinalizedCursorRecord,
  binding: ReleaseBinding,
): boolean {
  return (
    record.deploymentBlock === binding.deploymentBlock &&
    record.artifactChecksum === binding.artifactChecksum
  );
}

/**
 * Canonical finalized-block ingestion cursor (PREWAVE-BE-001).
 *
 * Guarantees:
 *  - Monotonic: neither heads nor the indexed watermark ever regress.
 *  - Contiguous: a range must start exactly at watermark + 1 (no gaps), and a
 *    range already at/below the watermark is a no-op (no duplicate effects).
 *  - Finalized-only: the watermark never passes the persisted finalized head.
 *  - Atomic: projection effects and the watermark commit in one transaction,
 *    so a restart at any point resumes from the last committed watermark.
 *  - Release-bound: every call and every event must match the persisted
 *    chain, release, deployment block and artifact checksum.
 */
@Injectable()
export class FinalizedCursorService<THandle = unknown> {
  private readonly logger = new Logger(FinalizedCursorService.name);
  private readonly config: FinalizedCursorConfig;

  private readonly blockGauge = gauge(
    'indexer_finalized_cursor_block',
    'Finalized cursor boundaries (observed, safe, finalized, indexed) per chain and release',
    ['chain_id', 'release_id', 'boundary'],
  );
  private readonly lagGauge = gauge(
    'indexer_finalized_cursor_lag_blocks',
    'Finalized cursor lag in blocks (finality = observed - finalized, index = finalized - indexed)',
    ['chain_id', 'release_id', 'kind'],
  );
  private readonly headAgeGauge = gauge(
    'indexer_finalized_cursor_head_age_seconds',
    'Seconds since chain heads were last observed from the provider',
    ['chain_id', 'release_id'],
  );
  private readonly readyGauge = gauge(
    'indexer_finalized_cursor_ready',
    '1 when the finalized cursor satisfies the freshness/lag policy, else 0',
    ['chain_id', 'release_id'],
  );

  constructor(
    @Inject(FINALIZED_CURSOR_STORE)
    private readonly store: FinalizedCursorStore<THandle>,
    @Optional()
    @Inject(FINALIZED_CURSOR_CONFIG)
    config?: FinalizedCursorConfig,
  ) {
    this.config = config ?? { binding: null, policy: DEFAULT_FRESHNESS_POLICY };
  }

  /** The release binding configured for this deployment, if any. */
  getConfiguredBinding(): ReleaseBinding | null {
    return this.config.binding;
  }

  isConfigured(): boolean {
    return this.config.binding !== null;
  }

  /**
   * Creates the cursor for a release at deploymentBlock - 1, or verifies an
   * existing cursor belongs to the same release. Idempotent.
   */
  async initialize(binding: ReleaseBinding): Promise<FinalizedCursorRecord> {
    this.validateBinding(binding);
    return this.store.transaction(async (tx) => {
      const existing = await tx.lockCursor(binding.chainId, binding.releaseId);
      if (existing) {
        this.assertBinding(existing, binding);
        return existing;
      }
      const record: FinalizedCursorRecord = {
        chainId: binding.chainId,
        releaseId: binding.releaseId,
        deploymentBlock: binding.deploymentBlock,
        artifactChecksum: binding.artifactChecksum,
        observedHead: null,
        safeHead: null,
        finalizedHead: null,
        headsObservedAt: null,
        indexedWatermark: binding.deploymentBlock - 1n,
        watermarkBlockHash: null,
        watermarkUpdatedAt: new Date(),
      };
      await tx.insertCursor(record);
      this.logger.log(
        `Initialized finalized cursor chain=${binding.chainId} release=${binding.releaseId}`,
      );
      return record;
    });
  }

  /**
   * Persists provider heads. Heads that would move any boundary backwards
   * (a lagging or inconsistent provider) are rejected without touching the
   * stored heads or their observation time, so freshness decays and
   * readiness fails closed rather than trusting stale data.
   */
  async recordHeads(
    binding: ReleaseBinding,
    heads: ChainHeads,
  ): Promise<RecordHeadsResult> {
    this.validateBinding(binding);
    if (
      heads.finalizedHead < 0n ||
      heads.safeHead < heads.finalizedHead ||
      heads.observedHead < heads.safeHead
    ) {
      throw new FinalizedCursorError(
        'INVALID_HEADS',
        'heads must satisfy 0 <= finalized <= safe <= observed',
      );
    }

    return this.store.transaction(async (tx) => {
      const current = await this.lockBound(tx, binding);
      if (
        (current.finalizedHead !== null &&
          heads.finalizedHead < current.finalizedHead) ||
        (current.safeHead !== null && heads.safeHead < current.safeHead) ||
        (current.observedHead !== null &&
          heads.observedHead < current.observedHead)
      ) {
        this.logger.warn(
          `Provider heads behind persisted cursor chain=${binding.chainId} release=${binding.releaseId}; ignoring`,
        );
        return { accepted: false, reason: 'PROVIDER_LAG' } as const;
      }
      await tx.updateHeads(binding.chainId, binding.releaseId, heads);
      return { accepted: true } as const;
    });
  }

  /** Reads latest/safe/finalized from a provider and records them. */
  async observeHeadsFromProvider(
    binding: ReleaseBinding,
    provider: HeadProvider,
    now: () => Date = () => new Date(),
  ): Promise<RecordHeadsResult> {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== binding.chainId) {
      throw new FinalizedCursorError(
        'WRONG_RELEASE',
        'provider chain does not match release binding',
      );
    }
    const [latest, safe, finalized] = await Promise.all([
      provider.getBlock('latest'),
      provider.getBlock('safe'),
      provider.getBlock('finalized'),
    ]);
    if (!latest || !safe || !finalized) {
      throw new FinalizedCursorError(
        'INVALID_HEADS',
        'provider did not report latest, safe and finalized heads',
      );
    }
    return this.recordHeads(binding, {
      observedHead: BigInt(latest.number),
      safeHead: BigInt(safe.number),
      finalizedHead: BigInt(finalized.number),
      observedAt: now(),
    });
  }

  /**
   * Applies one contiguous finalized range. Effects and the watermark advance
   * commit together; on any failure both roll back.
   */
  async applyFinalizedRange(
    binding: ReleaseBinding,
    range: FinalizedRange,
    effects: ProjectionEffects<THandle>,
  ): Promise<ApplyRangeResult> {
    this.validateBinding(binding);
    this.validateRange(binding, range);

    return this.store.transaction(async (tx) => {
      const current = await this.lockBound(tx, binding);
      const watermark = current.indexedWatermark;

      if (range.toBlock <= watermark) {
        return { status: 'duplicate', indexedWatermark: watermark } as const;
      }
      if (range.fromBlock <= watermark) {
        throw new FinalizedCursorError(
          'OVERLAP',
          `range starts at ${range.fromBlock} but watermark is ${watermark}`,
        );
      }
      if (range.fromBlock !== watermark + 1n) {
        throw new FinalizedCursorError(
          'GAP',
          `range starts at ${range.fromBlock}, expected ${watermark + 1n}`,
        );
      }
      if (
        current.finalizedHead === null ||
        range.toBlock > current.finalizedHead
      ) {
        throw new FinalizedCursorError(
          'NOT_FINALIZED',
          `range ends at ${range.toBlock} beyond finalized head ${current.finalizedHead ?? 'unknown'}`,
        );
      }

      await effects(tx.handle, range.events);

      const advanced = await tx.advanceWatermark(
        binding.chainId,
        binding.releaseId,
        watermark,
        range.toBlock,
        range.toBlockHash,
        new Date(),
      );
      if (!advanced) {
        throw new FinalizedCursorError(
          'CONCURRENT_UPDATE',
          'watermark moved during transaction',
        );
      }
      return {
        status: 'applied',
        indexedWatermark: range.toBlock,
        eventCount: range.events.length,
      } as const;
    });
  }

  /** Sanitized status for readiness, metrics and the public status projection. */
  async getStatus(
    binding: ReleaseBinding,
    now: Date = new Date(),
  ): Promise<FinalizedCursorStatus> {
    const policy = this.config.policy;
    const record = await this.store.read(binding.chainId, binding.releaseId);
    const status = this.buildStatus(binding, record, policy, now);
    this.publishMetrics(status);
    return status;
  }

  /** Status of the configured binding, or null when none is configured. */
  async getConfiguredStatus(
    now: Date = new Date(),
  ): Promise<FinalizedCursorStatus | null> {
    const binding = this.config.binding;
    return binding ? this.getStatus(binding, now) : null;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private buildStatus(
    binding: ReleaseBinding,
    record: FinalizedCursorRecord | null,
    policy: FreshnessPolicy,
    now: Date,
  ): FinalizedCursorStatus {
    const base = {
      chainId: binding.chainId,
      releaseId: binding.releaseId,
      policy,
    };
    if (!record) {
      return {
        ...base,
        initialized: false,
        ready: false,
        reasons: ['CURSOR_MISSING'],
        observedHead: null,
        safeHead: null,
        finalizedHead: null,
        indexedWatermark: null,
        finalityLagBlocks: null,
        indexLagBlocks: null,
        headsObservedAt: null,
        headAgeMs: null,
        watermarkUpdatedAt: null,
      };
    }

    const reasons: CursorNotReadyReason[] = [];
    if (!matchesBinding(record, binding)) reasons.push('WRONG_RELEASE');

    const headAgeMs = record.headsObservedAt
      ? Math.max(0, now.getTime() - record.headsObservedAt.getTime())
      : null;
    if (headAgeMs === null) reasons.push('HEADS_NEVER_OBSERVED');
    else if (headAgeMs > policy.maxHeadAgeMs) reasons.push('HEADS_STALE');

    let indexLag: bigint | null = null;
    if (record.finalizedHead !== null) {
      indexLag = record.finalizedHead - record.indexedWatermark;
      if (indexLag < 0n) indexLag = 0n;
      if (indexLag > BigInt(policy.maxIndexLagBlocks)) {
        reasons.push('INDEX_LAG_EXCEEDED');
      }
    }
    const finalityLag =
      record.observedHead !== null && record.finalizedHead !== null
        ? record.observedHead - record.finalizedHead
        : null;

    return {
      ...base,
      initialized: true,
      ready: reasons.length === 0,
      reasons,
      observedHead: toSafeNumber(record.observedHead),
      safeHead: toSafeNumber(record.safeHead),
      finalizedHead: toSafeNumber(record.finalizedHead),
      indexedWatermark: toSafeNumber(record.indexedWatermark),
      finalityLagBlocks: toSafeNumber(finalityLag),
      indexLagBlocks: toSafeNumber(indexLag),
      headsObservedAt: record.headsObservedAt?.toISOString() ?? null,
      headAgeMs,
      watermarkUpdatedAt: record.watermarkUpdatedAt.toISOString(),
    };
  }

  private publishMetrics(status: FinalizedCursorStatus): void {
    const labels = {
      chain_id: String(status.chainId),
      release_id: status.releaseId,
    };
    const boundaries: Array<[string, number | null]> = [
      ['observed', status.observedHead],
      ['safe', status.safeHead],
      ['finalized', status.finalizedHead],
      ['indexed', status.indexedWatermark],
    ];
    for (const [boundary, value] of boundaries) {
      if (value !== null) this.blockGauge.set({ ...labels, boundary }, value);
    }
    if (status.finalityLagBlocks !== null) {
      this.lagGauge.set(
        { ...labels, kind: 'finality' },
        status.finalityLagBlocks,
      );
    }
    if (status.indexLagBlocks !== null) {
      this.lagGauge.set({ ...labels, kind: 'index' }, status.indexLagBlocks);
    }
    if (status.headAgeMs !== null) {
      this.headAgeGauge.set(labels, status.headAgeMs / 1000);
    }
    this.readyGauge.set(labels, status.ready ? 1 : 0);
  }

  private async lockBound(
    tx: FinalizedCursorTransaction<THandle>,
    binding: ReleaseBinding,
  ): Promise<FinalizedCursorRecord> {
    const current = await tx.lockCursor(binding.chainId, binding.releaseId);
    if (!current) {
      throw new FinalizedCursorError(
        'NOT_INITIALIZED',
        `no cursor for chain ${binding.chainId} release ${binding.releaseId}`,
      );
    }
    this.assertBinding(current, binding);
    return current;
  }

  private assertBinding(
    record: FinalizedCursorRecord,
    binding: ReleaseBinding,
  ): void {
    if (!matchesBinding(record, binding)) {
      throw new FinalizedCursorError(
        'WRONG_RELEASE',
        `cursor for chain ${binding.chainId} release ${binding.releaseId} is bound to a different deployment block or artifact checksum`,
      );
    }
  }

  private validateBinding(binding: ReleaseBinding): void {
    try {
      assertValidBinding(binding);
    } catch (error) {
      throw new FinalizedCursorError(
        'INVALID_BINDING',
        (error as Error).message,
      );
    }
  }

  private validateRange(binding: ReleaseBinding, range: FinalizedRange): void {
    if (range.fromBlock > range.toBlock) {
      throw new FinalizedCursorError('INVALID_RANGE', 'fromBlock > toBlock');
    }
    if (range.fromBlock < binding.deploymentBlock) {
      throw new FinalizedCursorError(
        'INVALID_RANGE',
        'range starts before the release deployment block',
      );
    }
    if (!BLOCK_HASH_PATTERN.test(range.toBlockHash)) {
      throw new FinalizedCursorError(
        'INVALID_RANGE',
        'toBlockHash is not a block hash',
      );
    }

    let previous: CanonicalEvent | null = null;
    for (const event of range.events) {
      if (
        event.chainId !== binding.chainId ||
        event.releaseId !== binding.releaseId
      ) {
        throw new FinalizedCursorError(
          'WRONG_RELEASE',
          'event is bound to a different chain or release',
        );
      }
      if (
        event.blockNumber < range.fromBlock ||
        event.blockNumber > range.toBlock
      ) {
        throw new FinalizedCursorError(
          'INVALID_RANGE',
          `event at block ${event.blockNumber} outside range`,
        );
      }
      if (previous) {
        const sameBlock = event.blockNumber === previous.blockNumber;
        if (sameBlock && event.logIndex === previous.logIndex) {
          throw new FinalizedCursorError(
            'DUPLICATE_EVENT',
            `duplicate event at block ${event.blockNumber} log ${event.logIndex}`,
          );
        }
        if (
          event.blockNumber < previous.blockNumber ||
          (sameBlock && event.logIndex < previous.logIndex)
        ) {
          throw new FinalizedCursorError(
            'OUT_OF_ORDER',
            `event at block ${event.blockNumber} log ${event.logIndex} is out of canonical order`,
          );
        }
        if (sameBlock && event.blockHash !== previous.blockHash) {
          throw new FinalizedCursorError(
            'INVALID_RANGE',
            `conflicting block hashes at block ${event.blockNumber}`,
          );
        }
      }
      previous = event;
    }
  }
}
