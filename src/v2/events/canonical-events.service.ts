import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ArtifactRegistryService } from './artifact-registry.service';
import { EventDecoderService } from './event-decoder.service';
import { CanonicalEvent } from './entities/canonical-event.entity';
import {
  QuarantineFailureKind,
  QuarantineReason,
} from './entities/event-quarantine.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { RawLog, IngestOutcome } from './interfaces/canonical-event.interface';
import { IndexerConfigService } from '../../config/indexer-config.service';
import { EventQuarantineService } from './event-quarantine.service';
import {
  CANONICAL_CHAIN_HEADS,
  ChainHeadsProvider,
  DEFAULT_MAX_HEAD_AGE_MS,
  validateChainHeads,
} from './chain-heads';

/** Postgres unique_violation error code. */
const PG_UNIQUE_VIOLATION = '23505';

const HEX_32 = /^0x[a-fA-F0-9]{64}$/;
const HEX = /^0x[a-fA-F0-9]*$/;

/** Structural validation: reject malformed logs before any decoding attempt. */
export function isWellFormedRawLog(log: RawLog): boolean {
  if (!log || typeof log !== 'object') return false;
  if (!Number.isInteger(log.chainId) || log.chainId <= 0) return false;
  if (
    typeof log.address !== 'string' ||
    !/^0x[a-fA-F0-9]{40}$/.test(log.address)
  ) {
    return false;
  }
  if (!Array.isArray(log.topics) || log.topics.length > 8) return false;
  if (
    !log.topics.every(
      (topic) => typeof topic === 'string' && HEX_32.test(topic),
    )
  ) {
    return false;
  }
  if (
    typeof log.data !== 'string' ||
    !HEX.test(log.data) ||
    log.data.length % 2 !== 0
  ) {
    return false;
  }
  if (
    typeof log.transactionHash !== 'string' ||
    !HEX_32.test(log.transactionHash)
  ) {
    return false;
  }
  if (!Number.isInteger(log.logIndex) || log.logIndex < 0) return false;
  if (typeof log.blockNumber !== 'bigint' || log.blockNumber < 0n) return false;
  return true;
}

@Injectable()
export class CanonicalEventsService {
  private readonly logger = new Logger(CanonicalEventsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly artifacts: ArtifactRegistryService,
    private readonly decoder: EventDecoderService,
    private readonly indexerConfig: IndexerConfigService,
    private readonly quarantine: EventQuarantineService,
    @Optional()
    @Inject(CANONICAL_CHAIN_HEADS)
    private readonly chainHeads?: ChainHeadsProvider,
  ) {}

  /**
   * Reads the authoritative provider heads for this log's chain. No provider
   * response (or an invalid/stale/contradictory one) yields null, which makes
   * ingestion fail closed on finality while still recording progress.
   */
  private async readHeads(chainId: number) {
    if (!this.chainHeads) return null;
    try {
      return validateChainHeads(
        await this.chainHeads.getHeads(chainId),
        chainId,
        new Date(),
        DEFAULT_MAX_HEAD_AGE_MS,
      );
    } catch (error) {
      this.logger.warn(
        `Provider head observation failed for chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Ingest one raw log. Idempotent: replaying the same (chainId, txHash,
   * logIndex) is a no-op on the second and subsequent calls. Every branch
   * (malformed, unregistered address, ABI mismatch, unknown topic, decode
   * error, artifact drift, duplicate, success) is represented explicitly in
   * the return type so callers/tests can assert on it rather than inferring it
   * from side effects.
   *
   * Events are keyed by canonical signature/topic0 for overload support.
   */
  async ingest(log: RawLog): Promise<IngestOutcome> {
    // Malformed/truncated logs are quarantined before anything else: they must
    // never reach the decoder or a projection.
    if (!isWellFormedRawLog(log)) {
      await this.recordSafety(log, {
        reason: QuarantineReason.DECODE_ERROR,
        failureKind: QuarantineFailureKind.MALFORMED_LOG,
        detail: 'malformed log shape (topics/data/txHash/blockNumber)',
      });
      return { status: 'quarantined', reason: QuarantineReason.DECODE_ERROR };
    }

    const resolution = await this.artifacts.resolveDetailed(
      log.chainId,
      log.address,
    );
    if (resolution.status === 'unregistered') {
      await this.quarantine.record({
        log,
        reason: QuarantineReason.UNREGISTERED_ADDRESS,
        failureKind: QuarantineFailureKind.UNREGISTERED_ADDRESS,
        detail: 'no approved artifact for this address',
      });
      return {
        status: 'quarantined',
        reason: QuarantineReason.UNREGISTERED_ADDRESS,
      };
    }
    if (resolution.status === 'invalid_artifact') {
      await this.quarantine.record({
        log,
        reason: QuarantineReason.ABI_MISMATCH,
        failureKind: QuarantineFailureKind.ABI_MISMATCH,
        detail: resolution.detail,
      });
      return { status: 'quarantined', reason: QuarantineReason.ABI_MISMATCH };
    }

    const decoded = this.decoder.decode(log, resolution.iface);
    if (decoded.status === 'unknown_signature') {
      await this.quarantine.record({
        log,
        reason: QuarantineReason.UNKNOWN_SIGNATURE,
        failureKind: QuarantineFailureKind.UNKNOWN_TOPIC,
        detail: 'topic0 matched no fragment in the approved ABI',
        artifactVersion: resolution.artifactVersion,
        abiChecksum: resolution.abiChecksum,
      });
      return {
        status: 'quarantined',
        reason: QuarantineReason.UNKNOWN_SIGNATURE,
      };
    }
    if (decoded.status === 'decode_error') {
      await this.quarantine.record({
        log,
        reason: QuarantineReason.DECODE_ERROR,
        failureKind: QuarantineFailureKind.DECODER_FAILURE,
        detail: decoded.error,
        artifactVersion: resolution.artifactVersion,
        abiChecksum: resolution.abiChecksum,
      });
      return { status: 'quarantined', reason: QuarantineReason.DECODE_ERROR };
    }

    const normalized = this.decoder.normalize(
      log,
      resolution.artifactVersion,
      decoded.description,
      decoded.signature,
    );
    if (normalized.status === 'artifact_drift') {
      await this.quarantine.record({
        log,
        reason: QuarantineReason.ARTIFACT_DRIFT,
        failureKind: QuarantineFailureKind.ARTIFACT_DRIFT,
        detail: `decoded event "${normalized.eventName}" has no canonical schema mapping`,
        artifactVersion: resolution.artifactVersion,
        abiChecksum: resolution.abiChecksum,
        eventSignature: decoded.signature,
      });
      this.logger.warn(
        `Artifact drift: unmapped event "${normalized.eventName}" from ${log.address}`,
      );
      return { status: 'quarantined', reason: QuarantineReason.ARTIFACT_DRIFT };
    }

    const heads = await this.readHeads(log.chainId);

    return this.dataSource.transaction(async (manager) => {
      try {
        await manager.insert(CanonicalEvent, {
          chainId: normalized.event.chainId,
          contractAddress: normalized.event.contractAddress,
          artifactVersion: normalized.event.artifactVersion,
          eventName: normalized.event.eventName,
          eventSignature: normalized.event.eventSignature,
          txHash: normalized.event.txHash,
          logIndex: normalized.event.logIndex,
          blockNumber: normalized.event.blockNumber.toString(),
          blockTimestamp: normalized.event.blockTimestamp,
          actor: normalized.event.actor,
          claimId: normalized.event.claimId,
          roundId: normalized.event.roundId,
          asset: normalized.event.asset,
          amount: normalized.event.amount,
          payload: normalized.event.payload as object,
          rawArgs: normalized.event.rawArgs as object,
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          return { status: 'duplicate' };
        }
        throw err;
      }

      // Progress and finality are distinct facts. Ingestion always advances
      // progress; safe/finalized only ever follow validated provider heads.
      await this.advanceCheckpoint(
        manager,
        log.chainId,
        normalized.event.contractAddress,
        normalized.event.blockNumber,
        heads,
      );

      return { status: 'ingested', event: normalized.event };
    });
  }

  /**
   * Advances the durable checkpoint inside the ingestion transaction.
   *
   * Progress follows the ingested log. Safe/finalized follow provider heads
   * only, are clamped to `finalized <= safe <= observed`, and are monotonic so
   * regressing observations can never move a watermark backward. When heads
   * are unavailable the finality fields and their provenance are left intact.
   */
  private async advanceCheckpoint(
    manager: EntityManager,
    chainId: number,
    contractAddress: string,
    processedBlock: bigint,
    heads: ReturnType<typeof validateChainHeads>,
  ): Promise<void> {
    const repo = manager.getRepository(EventCheckpoint);
    const query = repo
      .createQueryBuilder('checkpoint')
      .where(
        'checkpoint.chainId = :chainId AND checkpoint.contractAddress = :contractAddress',
        { chainId, contractAddress },
      );
    // Postgres serializes concurrent writers on the checkpoint row; sqlite is
    // single-writer and ignores row locks.
    if (manager.connection.options.type === 'postgres') {
      query.setLock('pessimistic_write');
    }
    const existing = await query.getOne();
    const checkpoint =
      existing ??
      repo.create({
        chainId,
        contractAddress,
        lastProcessedBlock: '0',
        lastSafeBlock: '0',
        lastFinalizedBlock: '0',
        lastSafeBlockHash: null,
        lastFinalizedBlockHash: null,
        observedHead: null,
        headSource: null,
        headsObservedAt: null,
      });

    const currentProcessed = this.toBigInt(checkpoint.lastProcessedBlock);
    const currentSafe = this.toBigInt(checkpoint.lastSafeBlock);
    const currentFinalized = this.toBigInt(checkpoint.lastFinalizedBlock);
    checkpoint.lastProcessedBlock = (
      currentProcessed > processedBlock ? currentProcessed : processedBlock
    ).toString();

    if (heads) {
      const observed = heads.observedHead;
      const safe = heads.safeHead < observed ? heads.safeHead : observed;
      const finalized = heads.finalizedHead < safe ? heads.finalizedHead : safe;
      const nextSafe = currentSafe > safe ? currentSafe : safe;
      let nextFinalized =
        currentFinalized > finalized ? currentFinalized : finalized;
      if (nextFinalized > nextSafe) nextFinalized = nextSafe;

      checkpoint.lastSafeBlock = nextSafe.toString();
      checkpoint.lastFinalizedBlock = nextFinalized.toString();
      checkpoint.observedHead = observed.toString();
      checkpoint.headSource = heads.source;
      checkpoint.headsObservedAt = heads.observedAt;
      if (heads.safeBlockHash && nextSafe === safe) {
        checkpoint.lastSafeBlockHash = heads.safeBlockHash;
      }
      if (heads.finalizedBlockHash && nextFinalized === finalized) {
        checkpoint.lastFinalizedBlockHash = heads.finalizedBlockHash;
      }
    }

    // A lost insert race aborts the whole transaction (including the event
    // write), so a concurrent batch can never leave conflicting checkpoints.
    if (existing) {
      await repo.save(checkpoint);
    } else {
      await repo.insert(checkpoint);
    }
  }

  private toBigInt(value: unknown): bigint {
    try {
      if (value === null || value === undefined) return 0n;
      const parsed = BigInt(value as string);
      return parsed < 0n ? 0n : parsed;
    } catch {
      return 0n;
    }
  }

  /**
   * Best-effort quarantine for a structurally invalid log. We can only persist
   * a row when the identity fields are usable; otherwise log and fail closed
   * without mutating projections.
   */
  private async recordSafety(
    log: RawLog,
    input: Pick<
      Parameters<EventQuarantineService['record']>[0],
      'reason' | 'failureKind' | 'detail'
    >,
  ): Promise<void> {
    const canPersist =
      log &&
      typeof log === 'object' &&
      Number.isInteger(log.chainId) &&
      typeof log.address === 'string' &&
      typeof log.transactionHash === 'string' &&
      Number.isInteger(log.logIndex) &&
      typeof log.blockNumber === 'bigint';

    if (!canPersist) {
      this.logger.warn(
        'Dropped structurally invalid log with unusable identity (not persisted)',
      );
      return;
    }

    try {
      await this.quarantine.record({
        log,
        reason: input.reason,
        failureKind: input.failureKind,
        detail: input.detail,
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist malformed-log quarantine: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    return (
      code === PG_UNIQUE_VIOLATION ||
      (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'))
    );
  }

  /**
   * Observable quarantine inspection: counts events that still block readiness.
   * Replayed rows no longer block.
   */
  async getQuarantineCount(chainId?: number): Promise<number> {
    return this.quarantine.getBlockingCount(chainId);
  }

  /**
   * Checks whether observable quarantine status blocks readiness.
   * If any open quarantined event is present, readiness fails closed.
   */
  async isReadinessBlockedByQuarantine(chainId?: number): Promise<boolean> {
    const count = await this.getQuarantineCount(chainId);
    return count > 0;
  }
}
