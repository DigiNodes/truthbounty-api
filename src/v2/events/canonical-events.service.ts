import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ArtifactRegistryService } from './artifact-registry.service';
import { EventDecoderService } from './event-decoder.service';
import { CanonicalEvent } from './entities/canonical-event.entity';
import {
  EventQuarantine,
  QuarantineReason,
} from './entities/event-quarantine.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { RawLog, IngestOutcome } from './interfaces/canonical-event.interface';

/** Postgres unique_violation error code. */
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class CanonicalEventsService {
  private readonly logger = new Logger(CanonicalEventsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly artifacts: ArtifactRegistryService,
    private readonly decoder: EventDecoderService,
  ) {}

  /**
   * Ingest one raw log. Idempotent: replaying the same (chainId, txHash,
   * logIndex) is a no-op on the second and subsequent calls. Every branch
   * (unregistered address, unknown signature, decode error, artifact drift,
   * duplicate, success) is represented explicitly in the return type so
   * callers/tests can assert on it rather than inferring it from side effects.
   */
  async ingest(log: RawLog): Promise<IngestOutcome> {
    const resolved = await this.artifacts.resolve(log.chainId, log.address);
    if (!resolved) {
      await this.quarantine(
        log,
        QuarantineReason.UNREGISTERED_ADDRESS,
        null,
        'no approved artifact for this address',
      );
      return {
        status: 'quarantined',
        reason: QuarantineReason.UNREGISTERED_ADDRESS,
      };
    }

    const decoded = this.decoder.decode(log, resolved.iface);
    if (decoded.status === 'unknown_signature') {
      await this.quarantine(
        log,
        QuarantineReason.UNKNOWN_SIGNATURE,
        log.topics[0] ?? null,
        'topic0 matched no fragment in approved ABI',
      );
      return {
        status: 'quarantined',
        reason: QuarantineReason.UNKNOWN_SIGNATURE,
      };
    }
    if (decoded.status === 'decode_error') {
      await this.quarantine(
        log,
        QuarantineReason.DECODE_ERROR,
        log.topics[0] ?? null,
        decoded.error,
      );
      return { status: 'quarantined', reason: QuarantineReason.DECODE_ERROR };
    }

    const normalized = this.decoder.normalize(
      log,
      resolved.artifactVersion,
      decoded.description,
    );
    if (normalized.status === 'artifact_drift') {
      await this.quarantine(
        log,
        QuarantineReason.ARTIFACT_DRIFT,
        log.topics[0] ?? null,
        `decoded event "${normalized.eventName}" has no canonical schema mapping`,
      );
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
          return { status: 'duplicate' } as IngestOutcome;
        }
        throw err;
      }

      // Advance the checkpoint atomically with the event write. Monotonic:
      // never move the cursor backward, so out-of-order batches can't regress it.
      const checkpointRepo = manager.getRepository(EventCheckpoint);
      const existing = await checkpointRepo.findOne({
        where: {
          chainId: log.chainId,
          contractAddress: normalized.event.contractAddress,
        },
      });
      if (!existing) {
        await checkpointRepo.insert({
          chainId: log.chainId,
          contractAddress: normalized.event.contractAddress,
          lastSafeBlock: normalized.event.blockNumber.toString(),
        });
      } else if (
        BigInt(existing.lastSafeBlock) < normalized.event.blockNumber
      ) {
        await checkpointRepo.update(existing.id, {
          lastSafeBlock: normalized.event.blockNumber.toString(),
        });
      }

      return { status: 'ingested', event: normalized.event } as IngestOutcome;
    });
  }

  private async quarantine(
    log: RawLog,
    reason: QuarantineReason,
    topic0: string | null,
    detail: string,
  ): Promise<void> {
    try {
      await this.dataSource.getRepository(EventQuarantine).insert({
        chainId: log.chainId,
        contractAddress: log.address.toLowerCase(),
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber.toString(),
        topic0,
        reason,
        rawLog: { topics: log.topics, data: log.data },
        detail,
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      // Already quarantined for this identity; replay is idempotent.
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    // Postgres (production) uses the SQLSTATE code; sqlite (used only in the
    // fast in-memory integration test) reports its own constraint code.
    return code === PG_UNIQUE_VIOLATION || code === 'SQLITE_CONSTRAINT';
  }
}
