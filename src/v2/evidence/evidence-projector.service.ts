import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import {
  ProjectEvidence,
  EvidenceStatus,
} from './entities/project-evidence.entity';
import { ProjectEvidenceVersion } from './entities/project-evidence-version.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';

const PROJECTOR_NAME = 'v2-evidence';
const PG_UNIQUE_VIOLATION = '23505';
const HANDLED_EVENT_NAMES = [
  'EvidenceRegistered',
  'EvidenceReplaced',
  'EvidenceRemoved',
];

export interface ProjectorRunSummary {
  processed: number;
  applied: number;
  duplicates: number;
}

/**
 * Projects the append-only evidence read models from canonical events.
 *
 * Read-only from the API's perspective: the only writer of
 * v2_project_evidence / v2_project_evidence_version is this projector,
 * replaying canonical events. There is no create/update/delete endpoint for
 * evidence content in this module, by design (V2-BE-013 AC: "No
 * backend-authoritative protocol mutation is introduced").
 */
@Injectable()
export class EvidenceProjectorService {
  private readonly logger = new Logger(EvidenceProjectorService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly canonicalEvents: CanonicalEventQueryService,
  ) {}

  /** Process up to `batchSize` new canonical events since the last run. Idempotent. */
  async processNewEvents(batchSize = 100): Promise<ProjectorRunSummary> {
    const cursorRepo = this.dataSource.getRepository(ProjectorCursor);
    const cursor = await cursorRepo.findOne({
      where: { projectorName: PROJECTOR_NAME },
    });
    const after = cursor
      ? { blockNumber: cursor.lastBlockNumber, logIndex: cursor.lastLogIndex }
      : null;

    const events = await this.canonicalEvents.findAfter(
      HANDLED_EVENT_NAMES,
      after,
      batchSize,
    );
    const summary: ProjectorRunSummary = {
      processed: 0,
      applied: 0,
      duplicates: 0,
    };

    for (const event of events) {
      summary.processed += 1;
      const outcome = await this.applyEvent(event);
      if (outcome === 'applied') summary.applied += 1;
      if (outcome === 'duplicate') summary.duplicates += 1;

      await cursorRepo.upsert(
        {
          projectorName: PROJECTOR_NAME,
          lastBlockNumber: event.blockNumber,
          lastLogIndex: event.logIndex,
        },
        ['projectorName'],
      );
    }

    return summary;
  }

  private async applyEvent(
    event: CanonicalEvent,
  ): Promise<'applied' | 'duplicate'> {
    if (!event.claimId) {
      this.logger.warn(
        `Skipping ${event.eventName} (${event.txHash}:${event.logIndex}): missing claimId`,
      );
      return 'duplicate';
    }

    // One evidence slot per claim, matching the legacy 1:1 Claim<->Evidence
    // shape being superseded. Flagged assumption: if the approved protocol
    // ever supports multiple evidence slots per claim, this projector will
    // need a real per-slot identifier from the event payload instead.
    const evidenceId = event.claimId;
    const claimId = event.claimId;

    return this.dataSource.transaction(async (manager) => {
      const evidenceRepo = manager.getRepository(ProjectEvidence);
      const versionRepo = manager.getRepository(ProjectEvidenceVersion);

      if (
        event.eventName === 'EvidenceRegistered' ||
        event.eventName === 'EvidenceReplaced'
      ) {
        const digestValue = event.payload.digest;
        const digest =
          typeof digestValue === 'string' || typeof digestValue === 'number'
            ? String(digestValue)
            : '';
        const metadataValue = event.payload.metadataUri;
        const metadataUri =
          typeof metadataValue === 'string' || typeof metadataValue === 'number'
            ? String(metadataValue)
            : null;

        let evidence = await evidenceRepo.findOne({ where: { evidenceId } });
        const nextVersion = evidence ? evidence.currentVersion + 1 : 1;

        try {
          await versionRepo.insert({
            evidenceId,
            version: nextVersion,
            contentDigest: digest,
            safeMetadataUri: metadataUri,
            submittedBy: event.actor,
            eventTxHash: event.txHash,
            eventLogIndex: event.logIndex,
            blockNumber: event.blockNumber,
          });
        } catch (err) {
          if (this.isUniqueViolation(err)) return 'duplicate';
          throw err;
        }

        if (!evidence) {
          evidence = evidenceRepo.create({
            evidenceId,
            claimId,
            currentVersion: 1,
            status: EvidenceStatus.ACTIVE,
            contentDigest: digest,
            lastEventBlockNumber: event.blockNumber,
            lastEventLogIndex: event.logIndex,
          });
        } else {
          evidence.currentVersion = nextVersion;
          evidence.status = EvidenceStatus.ACTIVE;
          evidence.contentDigest = digest;
          evidence.lastEventBlockNumber = event.blockNumber;
          evidence.lastEventLogIndex = event.logIndex;
        }
        await evidenceRepo.save(evidence);
        return 'applied';
      }

      if (event.eventName === 'EvidenceRemoved') {
        const evidence = await evidenceRepo.findOne({ where: { evidenceId } });
        if (!evidence) {
          this.logger.warn(
            `EvidenceRemoved for unknown evidenceId ${evidenceId}; ignoring`,
          );
          return 'duplicate';
        }
        if (evidence.status === EvidenceStatus.REMOVED) return 'duplicate';

        evidence.status = EvidenceStatus.REMOVED;
        evidence.lastEventBlockNumber = event.blockNumber;
        evidence.lastEventLogIndex = event.logIndex;
        await evidenceRepo.save(evidence);
        return 'applied';
      }

      return 'duplicate';
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    return code === PG_UNIQUE_VIOLATION || code === 'SQLITE_CONSTRAINT';
  }
}
