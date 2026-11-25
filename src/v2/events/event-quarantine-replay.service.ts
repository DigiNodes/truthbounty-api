import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AuditActionType,
  AuditCategory,
  AuditEntityType,
  AuditSeverity,
} from '../../audit/entities/audit-log.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { ArtifactRegistryService } from './artifact-registry.service';
import { CanonicalEventsService } from './canonical-events.service';
import { EventQuarantineService } from './event-quarantine.service';
import { QuarantineStatus } from './entities/event-quarantine.entity';
import { getCanonicalEventScope } from './canonical-event-scope';

export interface ReplayQuarantineInput {
  actorId: string;
  reason: string;
  expectedArtifactVersion?: string;
}

export interface ReplayQuarantineResult {
  status: 'replayed' | 'already_replayed';
  canonicalStatus: 'ingested' | 'duplicate' | 'already_replayed';
  quarantineId: string;
  artifactVersion: string;
}

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Reviewed, authorized, idempotent replay of a quarantined log
 * (PREWAVE-BE-053, #647).
 *
 * Replay re-resolves the (possibly updated) approved artifact, re-decodes via
 * the canonical ingest path, rewinds projector cursors so the newly-canonical
 * event is (re)consumed idempotently, then marks the row replayed and scrubs
 * its raw payload. A second replay is a no-op.
 */
@Injectable()
export class EventQuarantineReplayService {
  private readonly logger = new Logger(EventQuarantineReplayService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly quarantine: EventQuarantineService,
    private readonly artifacts: ArtifactRegistryService,
    private readonly canonical: CanonicalEventsService,
    private readonly config: ConfigService,
    @Optional() private readonly audit?: AuditTrailService,
  ) {}

  async replay(
    id: string,
    input: ReplayQuarantineInput,
  ): Promise<ReplayQuarantineResult> {
    const row = await this.quarantine.getRaw(id);

    if (row.status === QuarantineStatus.REPLAYED) {
      return {
        status: 'already_replayed',
        canonicalStatus: 'already_replayed',
        quarantineId: row.id,
        artifactVersion: row.artifactVersion ?? '',
      };
    }

    if (row.chainId !== getCanonicalEventScope().chainId) {
      await this.auditReject(id, input, 'chain_scope_mismatch');
      throw new ConflictException({
        errorCode: 'CHAIN_SCOPE_MISMATCH',
        message: 'The quarantined event is outside the configured chain scope.',
      });
    }

    const raw = row.rawLog as {
      topics?: string[];
      data?: string | null;
      truncated?: boolean;
    } | null;
    if (!raw || raw.truncated || typeof raw.data !== 'string') {
      await this.quarantine.markReplayFailed(id, 'raw_log_unavailable');
      await this.auditReject(id, input, 'raw_log_unavailable');
      throw new ConflictException({
        errorCode: 'RAW_LOG_UNAVAILABLE',
        message: 'The retained raw log is unavailable or was truncated.',
      });
    }

    // Reviewed replay: require the caller to acknowledge the artifact version
    // they reviewed, and re-resolve after clearing the cache.
    this.artifacts.clearCache();
    const resolved = await this.artifacts.resolveDetailed(
      row.chainId,
      row.contractAddress,
    );
    if (resolved.status !== 'ok') {
      const errorCode =
        resolved.status === 'invalid_artifact'
          ? 'artifact_invalid'
          : 'artifact_unregistered';
      await this.quarantine.markReplayFailed(id, errorCode);
      await this.auditReject(id, input, errorCode);
      throw new ConflictException({
        errorCode: 'ARTIFACT_NOT_READY',
        message:
          'No approved, valid artifact is available to decode this log yet.',
      });
    }

    if (
      input.expectedArtifactVersion &&
      input.expectedArtifactVersion !== resolved.artifactVersion
    ) {
      await this.quarantine.markReplayFailed(id, 'artifact_version_mismatch');
      await this.auditReject(id, input, 'artifact_version_mismatch');
      throw new ConflictException({
        errorCode: 'ARTIFACT_VERSION_MISMATCH',
        message: `Expected artifact ${input.expectedArtifactVersion}, resolved ${resolved.artifactVersion}.`,
      });
    }

    const outcome = await this.canonical.ingest({
      chainId: row.chainId,
      address: row.contractAddress,
      topics: raw.topics ?? [],
      data: raw.data,
      transactionHash: row.txHash,
      logIndex: row.logIndex,
      blockNumber: BigInt(row.blockNumber),
    });

    if (outcome.status === 'quarantined') {
      await this.quarantine.markReplayFailed(id, outcome.reason);
      await this.auditReject(id, input, outcome.reason);
      throw new ConflictException({
        errorCode: 'STILL_UNDECODABLE',
        message:
          'The log still cannot be decoded against the approved artifact.',
      });
    }

    await this.rewindProjectors(row.chainId, row.blockNumber, row.logIndex);

    const retentionDays = this.retentionDays();
    await this.quarantine.markReplayed(id, {
      replayedBy: input.actorId,
      artifactVersion: resolved.artifactVersion,
      retentionUntil: new Date(
        Date.now() + retentionDays * 24 * 60 * 60 * 1000,
      ),
    });

    await this.audit?.log({
      actionType: AuditActionType.EVENT_QUARANTINE_REPLAYED,
      entityType: AuditEntityType.EVENT_QUARANTINE,
      entityId: id,
      walletAddress: input.actorId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.OPERATIONS,
      description: `Quarantined event replayed (${outcome.status})`,
      metadata: {
        reason: input.reason,
        artifactVersion: resolved.artifactVersion,
        canonicalStatus: outcome.status,
        chainId: row.chainId,
        logIndex: row.logIndex,
      },
    });

    this.logger.log(
      `Replayed quarantine ${id} with artifact ${resolved.artifactVersion} (${outcome.status})`,
    );

    return {
      status: 'replayed',
      canonicalStatus: outcome.status,
      quarantineId: id,
      artifactVersion: resolved.artifactVersion,
    };
  }

  private retentionDays(): number {
    const raw = this.config.get<string | number>(
      'EVENT_QUARANTINE_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    );
    const days = Number(raw);
    return Number.isFinite(days) && days > 0
      ? Math.floor(days)
      : DEFAULT_RETENTION_DAYS;
  }

  /**
   * Move every projector cursor that has already passed the replayed position
   * back to just before it, so the event is re-consumed (idempotently).
   */
  private async rewindProjectors(
    chainId: number,
    blockNumber: string,
    logIndex: number,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(ProjectorCursor);
    const cursors = await repo.find();
    const targetBlock = BigInt(blockNumber);
    const scopeSuffix = `:${chainId}`;

    for (const cursor of cursors) {
      if (!cursor.projectorName.endsWith(scopeSuffix)) continue;
      const cursorBlock = BigInt(cursor.lastBlockNumber);
      const passed =
        cursorBlock > targetBlock ||
        (cursorBlock === targetBlock && cursor.lastLogIndex >= logIndex);
      if (!passed) continue;

      if (logIndex > 0) {
        await repo.update(
          { projectorName: cursor.projectorName },
          { lastBlockNumber: blockNumber, lastLogIndex: logIndex - 1 },
        );
      } else {
        await repo.update(
          { projectorName: cursor.projectorName },
          {
            lastBlockNumber: (targetBlock > 0n
              ? targetBlock - 1n
              : 0n
            ).toString(),
            lastLogIndex: -1,
          },
        );
      }
    }
  }

  private async auditReject(
    id: string,
    input: ReplayQuarantineInput,
    errorCode: string,
  ): Promise<void> {
    await this.audit?.log({
      actionType: AuditActionType.EVENT_QUARANTINE_REPLAY_REJECTED,
      entityType: AuditEntityType.EVENT_QUARANTINE,
      entityId: id,
      walletAddress: input.actorId,
      severity: AuditSeverity.MEDIUM,
      category: AuditCategory.SECURITY,
      description: `Quarantine replay rejected (${errorCode})`,
      metadata: { reason: input.reason, errorCode },
    });
  }
}
