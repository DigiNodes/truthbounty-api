import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
  ) {}

  private getFinalizedBlock(currentEventBlock: bigint): bigint {
    const config = this.indexerConfig.getEventIndexerConfig();
    return currentEventBlock - BigInt(config.confirmations.finalized);
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

      // Advance the checkpoint atomically with the event write. Monotonic:
      // never move any cursor backward, so out-of-order batches can't regress state.
      const newBlock = normalized.event.blockNumber;
      const newBlockStr = newBlock.toString();
      const finalizedBlock = this.getFinalizedBlock(newBlock);
      const finalizedBlockStr =
        finalizedBlock > 0n ? finalizedBlock.toString() : '0';

      const updateResult = await manager
        .createQueryBuilder()
        .update(EventCheckpoint)
        .set({
          lastSafeBlock: () => `GREATEST("lastSafeBlock", '${newBlockStr}')`,
          lastFinalizedBlock: () =>
            `GREATEST("lastFinalizedBlock", '${finalizedBlockStr}')`,
        })
        .where('chainId = :chainId AND contractAddress = :contractAddress', {
          chainId: log.chainId,
          contractAddress: normalized.event.contractAddress,
        })
        .execute();

      if (updateResult.affected === 0) {
        await manager.insert(EventCheckpoint, {
          chainId: log.chainId,
          contractAddress: normalized.event.contractAddress,
          lastSafeBlock: newBlockStr,
          lastFinalizedBlock: finalizedBlockStr,
        });
      }

      return { status: 'ingested', event: normalized.event };
    });
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
    return code === PG_UNIQUE_VIOLATION || code === 'SQLITE_CONSTRAINT';
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
