import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CanonicalEventQueryService } from '../events/canonical-event-query.service';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';
import {
  ProjectVerificationRound,
  RoundType,
  RoundStatus,
} from './entities/project-verification-round.entity';
import { ProjectParticipantPosition } from './entities/project-participant-position.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';

const PROJECTOR_NAME = 'v2-verification';
const PG_UNIQUE_VIOLATION = '23505';
const HANDLED_EVENT_NAMES = ['VerificationRoundOpened', 'PositionCommitted'];

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
 * Projects verification rounds and participant positions from canonical
 * events.
 *
 * ATOMIC PROJECTION BOUNDARY (V2-BE-047): each canonical chain event and its
 * cursor/checkpoint are committed in a single database transaction. A crash,
 * reorg, or duplicate delivery can never advance the cursor without its
 * projection (or persist a projection without the checkpoint) — the two move
 * or roll back together.
 *
 * ASSUMPTION FLAGGED FOR REVIEW: since V2-BE-008's approved ABI has not
 * landed, the payload keys this projector reads (roundType, roundNumber,
 * deadline, stake, reputationInput, effectiveWeight, verdict) are not yet
 * verified against a real event schema. They follow the vocabulary used in
 * the V2-BE-014 issue text itself and are expected to be reconciled once
 * the real approved artifact exists.
 */
@Injectable()
export class VerificationProjectorService {
  private readonly logger = new Logger(VerificationProjectorService.name);

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
      // The event projection and the cursor/checkpoint advance share one
      // transaction: either both become durable or neither does.
      const outcome = await this.dataSource.transaction(async (manager) => {
        const applied = await this.applyEvent(manager, event);
        await manager.getRepository(ProjectorCursor).upsert(
          {
            projectorName: PROJECTOR_NAME,
            lastBlockNumber: event.blockNumber,
            lastLogIndex: event.logIndex,
          },
          ['projectorName'],
        );
        return applied;
      });

      if (outcome === 'applied') summary.applied += 1;
      if (outcome === 'anomaly') summary.anomalies += 1;
    }

    return summary;
  }

  private async applyEvent(
    manager: EntityManager,
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    if (event.eventName === 'VerificationRoundOpened') {
      return this.applyRoundOpened(manager, event);
    }
    if (event.eventName === 'PositionCommitted') {
      return this.applyPositionCommitted(manager, event);
    }
    return 'duplicate';
  }

  private async applyRoundOpened(
    manager: EntityManager,
    event: CanonicalEvent,
  ): Promise<'applied' | 'duplicate'> {
    if (!event.claimId || !event.roundId) {
      this.logger.warn(
        `Skipping VerificationRoundOpened (${event.txHash}:${event.logIndex}): missing claimId/roundId`,
      );
      return 'duplicate';
    }

    const roundTypeRaw = readString(event.payload, 'roundType');
    const roundType =
      roundTypeRaw === RoundType.APPEAL ? RoundType.APPEAL : RoundType.FIRST;
    const roundNumberRaw = readString(event.payload, 'roundNumber');
    const roundNumber = roundNumberRaw ? Number(roundNumberRaw) : 1;

    const roundRepo = manager.getRepository(ProjectVerificationRound);
    try {
      await roundRepo.insert({
        roundId: event.roundId,
        claimId: event.claimId,
        roundType,
        roundNumber,
        deadline: readDate(event.payload, 'deadline'),
        status: RoundStatus.OPEN,
        openedAtBlock: event.blockNumber,
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
      });
      return 'applied';
    } catch (err) {
      if (this.isUniqueViolation(err)) return 'duplicate';
      throw err;
    }
  }

  private async applyPositionCommitted(
    manager: EntityManager,
    event: CanonicalEvent,
  ): Promise<'applied' | 'anomaly' | 'duplicate'> {
    if (!event.roundId || !event.actor) {
      this.logger.warn(
        `Skipping PositionCommitted (${event.txHash}:${event.logIndex}): missing roundId/actor`,
      );
      return 'duplicate';
    }

    const roundRepo = manager.getRepository(ProjectVerificationRound);
    const round = await roundRepo.findOne({
      where: { roundId: event.roundId },
    });
    if (!round) {
      // The round this position references hasn't been projected yet, even
      // though canonical events are consumed in ascending protocol order.
      // That's a real signal of an event-order inconsistency, not something
      // to silently drop or guess at.
      await this.recordAnomaly(
        manager,
        IndexingAnomalyKind.OUT_OF_ORDER,
        event.roundId,
        event,
        `PositionCommitted arrived before its VerificationRoundOpened for round ${event.roundId}`,
      );
      return 'anomaly';
    }

    const positionRepo = manager.getRepository(ProjectParticipantPosition);
    try {
      await positionRepo.insert({
        roundId: event.roundId,
        participant: event.actor,
        stake: readString(event.payload, 'stake') ?? '0',
        reputationInput: readString(event.payload, 'reputationInput'),
        effectiveWeight: readString(event.payload, 'effectiveWeight'),
        position: readString(event.payload, 'verdict'),
        eventTxHash: event.txHash,
        eventLogIndex: event.logIndex,
        blockNumber: event.blockNumber,
      });
      return 'applied';
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;

      // Distinguish "we already applied this exact event" (safe replay) from
      // "a different event tried to commit a second position for the same
      // participant in the same round" (a genuine protocol-level duplicate).
      const existing = await positionRepo.findOne({
        where: { eventTxHash: event.txHash, eventLogIndex: event.logIndex },
      });
      if (existing) return 'duplicate';

      await this.recordAnomaly(
        manager,
        IndexingAnomalyKind.DUPLICATE_EVENT,
        event.roundId,
        event,
        `Participant ${event.actor} already has a position in round ${event.roundId}`,
      );
      return 'anomaly';
    }
  }

  private async recordAnomaly(
    manager: EntityManager,
    kind: IndexingAnomalyKind,
    aggregateId: string,
    event: CanonicalEvent,
    detail: string,
  ): Promise<void> {
    this.logger.warn(`${kind}: ${detail}`);
    try {
      await manager.getRepository(IndexingAnomaly).insert({
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
