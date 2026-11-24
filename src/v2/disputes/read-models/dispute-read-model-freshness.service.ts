import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { EventCheckpoint } from '../../events/entities/event-checkpoint.entity';
import { BlockchainStateService } from '../../../blockchain/state.service';
import { ProjectDispute } from '../entities/project-dispute.entity';
import { ReadModelFreshness } from './dispute-read-model.types';

/**
 * Only reasons that make it unsafe to serve a read model are reported as
 * stale. Informational gaps (e.g. no live indexer snapshot wired in) are
 * tolerated because the durable finality checkpoint is authoritative; the
 * read model still fails closed on any *missing or ambiguous* finality.
 */

/** Default tolerated distance between the projection and the observed head. */
const DEFAULT_MAX_LAG_BLOCKS = 500;

export const DISPUTE_READ_MODEL_MAX_LAG_CONFIG_KEY =
  'DISPUTE_READ_MODEL_MAX_LAG_BLOCKS';
export const DISPUTE_READ_MODEL_MAX_AGE_CONFIG_KEY =
  'DISPUTE_READ_MODEL_MAX_AGE_MS';

/**
 * Derives the freshness/provenance-of-recency envelope for the dispute read
 * models from durable state only:
 *
 *  1. `v2_event_checkpoints` — safe/finalized heights + last advance time,
 *  2. `v2_project_dispute`    — the highest projected dispute block,
 *  3. an optional live indexer snapshot (observed head) when the process has
 *     one wired in.
 *
 * It never writes and never mutates protocol state. Missing finality is
 * surfaced as a stale reason so the caller can fail closed rather than
 * presenting provisional data as final.
 */
@Injectable()
export class DisputeReadModelFreshnessService {
  private readonly logger = new Logger(DisputeReadModelFreshnessService.name);

  constructor(
    @InjectRepository(EventCheckpoint)
    private readonly checkpointRepo: Repository<EventCheckpoint>,
    @InjectRepository(ProjectDispute)
    private readonly disputeRepo: Repository<ProjectDispute>,
    private readonly configService: ConfigService,
    @Optional()
    private readonly blockchainState?: BlockchainStateService,
  ) {}

  async snapshot(chainId: number): Promise<ReadModelFreshness> {
    const reasons = new Set<string>();

    const checkpoints = await this.readCheckpoints(chainId, reasons);
    const { safeBlock, finalizedBlock, lastSuccess } =
      this.aggregateCheckpoints(checkpoints);

    const indexedBlock = await this.readIndexedBlock(chainId, reasons);
    const snapshot = await this.readIndexerSnapshot();

    const observedHead =
      snapshot && snapshot.observedHeadBlock > 0
        ? snapshot.observedHeadBlock
        : null;

    const lagBlocks = this.computeLag(observedHead, indexedBlock);
    const reorgDetected =
      observedHead !== null &&
      indexedBlock !== null &&
      BigInt(indexedBlock) > BigInt(observedHead);

    if (finalizedBlock === null) reasons.add('finality_unavailable');
    if (reorgDetected) reasons.add('reorg_detected');

    const maxLag = this.readNonNegativeInt(
      DISPUTE_READ_MODEL_MAX_LAG_CONFIG_KEY,
      DEFAULT_MAX_LAG_BLOCKS,
    );
    if (lagBlocks !== null && BigInt(lagBlocks) > BigInt(maxLag)) {
      reasons.add('head_lag_exceeded');
    }

    const maxAgeMs = this.readNonNegativeInt(
      DISPUTE_READ_MODEL_MAX_AGE_CONFIG_KEY,
      0,
    );
    if (maxAgeMs > 0) {
      if (lastSuccess === null) {
        reasons.add('freshness_unavailable');
      } else if (Date.now() - Date.parse(lastSuccess) > maxAgeMs) {
        reasons.add('freshness_expired');
      }
    }

    if (snapshot && snapshot.status === 'unhealthy') {
      reasons.add('indexer_unhealthy');
    }

    const staleReasons = [...reasons].sort();

    return {
      indexedBlock,
      safeBlock,
      finalizedBlock,
      observedHead,
      lagBlocks,
      lastSuccess,
      stale: staleReasons.length > 0,
      staleReasons,
      reorgDetected,
    };
  }

  private async readCheckpoints(
    chainId: number,
    reasons: Set<string>,
  ): Promise<EventCheckpoint[]> {
    try {
      return await this.checkpointRepo.find({ where: { chainId } });
    } catch (err) {
      this.logger.warn(
        `Dispute read-model checkpoint read failed (chain ${chainId}): ${(err as Error)?.message ?? err}`,
      );
      reasons.add('checkpoints_unavailable');
      return [];
    }
  }

  private aggregateCheckpoints(checkpoints: EventCheckpoint[]): {
    safeBlock: string | null;
    finalizedBlock: string | null;
    lastSuccess: string | null;
  } {
    let safeBlock: bigint | null = null;
    let finalizedBlock: bigint | null = null;
    let lastSuccessMs = Number.NEGATIVE_INFINITY;

    for (const checkpoint of checkpoints) {
      const safe = this.toBigInt(checkpoint.lastSafeBlock);
      const finalized = this.toBigInt(checkpoint.lastFinalizedBlock);
      if (safe !== null && (safeBlock === null || safe > safeBlock)) {
        safeBlock = safe;
      }
      if (
        finalized !== null &&
        (finalizedBlock === null || finalized > finalizedBlock)
      ) {
        finalizedBlock = finalized;
      }
      if (checkpoint.updatedAt) {
        const ms = new Date(checkpoint.updatedAt).getTime();
        if (!Number.isNaN(ms) && ms > lastSuccessMs) lastSuccessMs = ms;
      }
    }

    return {
      safeBlock: safeBlock === null ? null : safeBlock.toString(),
      finalizedBlock:
        finalizedBlock === null ? null : finalizedBlock.toString(),
      lastSuccess:
        lastSuccessMs === Number.NEGATIVE_INFINITY
          ? null
          : new Date(lastSuccessMs).toISOString(),
    };
  }

  private async readIndexedBlock(
    chainId: number,
    reasons: Set<string>,
  ): Promise<string | null> {
    try {
      const raw = await this.disputeRepo
        .createQueryBuilder('dispute')
        .select('MAX(dispute.blockNumber)', 'maxBlock')
        .where('dispute.chainId = :chainId', { chainId })
        .getRawOne<{ maxBlock: string | number | null }>();
      return this.toBigInt(raw?.maxBlock ?? null)?.toString() ?? null;
    } catch (err) {
      this.logger.warn(
        `Dispute read-model indexed-block read failed (chain ${chainId}): ${(err as Error)?.message ?? err}`,
      );
      reasons.add('projection_unavailable');
      return null;
    }
  }

  private async readIndexerSnapshot(): Promise<Awaited<
    ReturnType<BlockchainStateService['getIndexerHealth']>
  > | null> {
    if (!this.blockchainState) {
      return null;
    }
    try {
      return await this.blockchainState.getIndexerHealth();
    } catch (err) {
      this.logger.warn(
        `Indexer health snapshot unavailable for dispute read models: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  private computeLag(
    observedHead: number | null,
    indexedBlock: string | null,
  ): string | null {
    if (observedHead === null || indexedBlock === null) return null;
    const distance = BigInt(observedHead) - BigInt(indexedBlock);
    return (distance > 0n ? distance : 0n).toString();
  }

  private readNonNegativeInt(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private toBigInt(value: unknown): bigint | null {
    if (value === null || value === undefined) return null;
    try {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number') {
        return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
      }
      if (typeof value !== 'string') return null;
      const text = value.trim();
      return text === '' ? null : BigInt(text);
    } catch {
      return null;
    }
  }
}
