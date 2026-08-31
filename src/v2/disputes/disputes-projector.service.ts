import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import {
  ProjectDispute,
  DisputeStatus,
} from './entities/project-dispute.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';

const PROJECTOR_NAME = 'v2-disputes';
const PG_UNIQUE_VIOLATION = '23505';
const HANDLED_EVENT_NAMES = [
  'DisputeRaised',
  'DisputeResolved',
  'DisputeExpired',
];

export interface ProjectorRunSummary {
  processed: number;
  applied: number;
  anomalies: number;
}

function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

function readDate(payload: Record<string, unknown>, key: string): Date | null {
  const raw = readString(payload, key);
  if (!raw) return null;
  const asNumber = Number(raw);
  const date =
    Number.isFinite(asNumber) && raw.trim() !== ''
      ? new Date(asNumber * 1000)
      : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Projects the dispute/appeal lifecycle from canonical events.
 *
 * State machine (explicit, fail-closed): RAISED -> RESOLVED, RAISED ->
 * EXPIRED. Any other transition -- resolving/expiring a dispute that was
 * never raised, or that is already RESOLVED/EXPIRED -- is rejected and
 * recorded as an INVALID_TRANSITION anomaly rather than silently applied,
 * per this issue's AC to represent invalid transitions explicitly.
 *
 * ASSUMPTION FLAGGED FOR REVIEW: payload keys (appealRoundId, deadline,
 * outcome) follow the vocabulary in the V2-BE-016 issue text; no frozen ABI
 * exists yet to confirm them (see event-schema-registry.ts).
 */
@Injectable()
export class DisputesProjectorService {
  private readonly logger = new Logger(DisputesProjectorService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly canonicalEvents: CanonicalEventQueryService,
  ) {}

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
      anomalies: 0,
    };

    for (const event of events) {
      summary.processed += 1;
      const outcome = await this.applyEvent(event);
      if (outcome === 'applied') summary.applied += 1;
      if (outcome === 'anomaly') summary.anomalies += 1;

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

  private deriveDisputeId(claimId: string, originalRoundId: string): string {
    return `${claimId}:${originalRoundId}`;
  }

  private async applyEvent(
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    if (!event.claimId || !event.roundId) {
      this.logger.warn(
        `Skipping ${event.eventName} (${event.txHash}:${event.logIndex}): missing claimId/roundId`,
      );
      return 'duplicate';
    }
    const disputeId = this.deriveDisputeId(event.claimId, event.roundId);

    if (event.eventName === 'DisputeRaised')
      return this.applyRaised(event, disputeId);
    if (event.eventName === 'DisputeResolved')
      return this.applyTerminal(event, disputeId, DisputeStatus.RESOLVED);
    if (event.eventName === 'DisputeExpired')
      return this.applyTerminal(event, disputeId, DisputeStatus.EXPIRED);
    return 'duplicate';
  }

  private async applyRaised(
    event: CanonicalEvent,
    disputeId: string,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    const disputeRepo = this.dataSource.getRepository(ProjectDispute);

    try {
      await disputeRepo.insert({
        disputeId,
        claimId: event.claimId!,
        originalRoundId: event.roundId!,
        appealRoundId: readString(event.payload, 'appealRoundId'),
        challengeBond: event.amount,
        challengeBondAsset: event.asset,
        status: DisputeStatus.RAISED,
        deadline: readDate(event.payload, 'deadline'),
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
      });
      return 'applied';
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;

      const existing = await disputeRepo.findOne({
        where: { eventTxHash: event.txHash, eventLogIndex: event.logIndex },
      });
      if (existing) return 'duplicate'; // safe replay of the same event

      await this.recordAnomaly(
        IndexingAnomalyKind.DUPLICATE_EVENT,
        disputeId,
        event,
        `A dispute already exists for round ${event.roundId} on claim ${event.claimId}`,
      );
      return 'anomaly';
    }
  }

  private async applyTerminal(
    event: CanonicalEvent,
    disputeId: string,
    nextStatus: DisputeStatus,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    const disputeRepo = this.dataSource.getRepository(ProjectDispute);
    const dispute = await disputeRepo.findOne({ where: { disputeId } });

    if (!dispute) {
      await this.recordAnomaly(
        IndexingAnomalyKind.INVALID_TRANSITION,
        disputeId,
        event,
        `${event.eventName} for a dispute that was never raised (round ${event.roundId})`,
      );
      return 'anomaly';
    }

    if (
      dispute.eventTxHash === event.txHash &&
      dispute.eventLogIndex === event.logIndex
    ) {
      return 'duplicate';
    }

    if (dispute.status !== DisputeStatus.RAISED) {
      await this.recordAnomaly(
        IndexingAnomalyKind.INVALID_TRANSITION,
        disputeId,
        event,
        `${event.eventName} rejected: dispute ${disputeId} is already ${dispute.status}, not raised`,
      );
      return 'anomaly';
    }

    dispute.status = nextStatus;
    dispute.eventTxHash = event.txHash;
    dispute.eventLogIndex = event.logIndex;
    if (nextStatus === DisputeStatus.RESOLVED) {
      dispute.resolvedOutcome = readString(event.payload, 'outcome');
    }
    await disputeRepo.save(dispute);
    return 'applied';
  }

  private async recordAnomaly(
    kind: IndexingAnomalyKind,
    aggregateId: string,
    event: CanonicalEvent,
    detail: string,
  ): Promise<void> {
    this.logger.warn(`${kind}: ${detail}`);
    try {
      await this.dataSource.getRepository(IndexingAnomaly).insert({
        sourceModule: PROJECTOR_NAME,
        kind,
        aggregateId,
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
        detail,
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    return code === PG_UNIQUE_VIOLATION || code === 'SQLITE_CONSTRAINT';
  }
}
