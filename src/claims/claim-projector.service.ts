import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CanonicalClaimEvent,
  EVENT_TYPE_TO_STATE,
} from '../domain/claim/canonical-claim-event';
import { isTransitionAllowed, ClaimState } from '../domain/claim/claimState';
import { ClaimLifecycleEvent } from './entities/claim-lifecycle-event.entity';
import { ClaimReadModel } from './entities/claim-read-model.entity';

/**
 * Claim projector: turns the canonical claim lifecycle event stream into a
 * queryable read model.
 *
 * The projector is *idempotent* and *replayable*:
 *  - Ingesting the same (claimId, blockNumber, eventIndex) twice is a no-op.
 *  - Out-of-order or stale events are dropped (we never regress state).
 *  - Illegal transitions (per `isTransitionAllowed`) are rejected and logged
 *    rather than silently corrupting the projection.
 *
 * This is the read model half of "V2-BE-012 — Project Claim Lifecycle Read
 * Model": the on-chain contract is the source of truth; this service is the
 * durable, queryable projection of it.
 */
@Injectable()
export class ClaimProjectorService {
  private readonly logger = new Logger(ClaimProjectorService.name);

  constructor(
    @InjectRepository(ClaimLifecycleEvent)
    private readonly eventRepo: Repository<ClaimLifecycleEvent>,
    @InjectRepository(ClaimReadModel)
    private readonly readModelRepo: Repository<ClaimReadModel>,
  ) {}

  /**
   * Project a single domain event (e.g. a decoded on-chain log) into the
   * lifecycle event log and the materialised read model.
   *
   * @returns the projected state, or null if the event was a stale duplicate
   *          or an illegal transition (both are non-fatal).
   */
  async project(event: CanonicalClaimEvent): Promise<ClaimState | null> {
    const targetState = EVENT_TYPE_TO_STATE[event.type];
    if (!targetState) {
      this.logger.warn(
        `Unknown lifecycle event type "${event.type}" — dropping`,
      );
      return null;
    }

    const stored = await this.persistEvent(event);
    if (!stored) {
      // Duplicate (or earlier) event already recorded — nothing new to apply.
      return null;
    }

    const current = await this.readModelRepo.findOne({
      where: { claimId: event.claimId, chainId: event.chainId },
    });

    const fromState: ClaimState = current?.state ?? ClaimState.Submitted;

    // The first event establishes the initial (SUBMITTED) state. Any lifecycle
    // must begin at SUBMITTED, so a first event that is not SUBMITTED is
    // rejected (we refuse to bootstrap a mid-lifecycle read model).
    const isInitial = !current;
    if (isInitial) {
      if (targetState !== ClaimState.Submitted) {
        this.logger.error(
          `Cannot bootstrap claim ${event.claimId} at ${targetState}; ` +
            `lifecycle must begin at ${ClaimState.Submitted}`,
        );
        return null;
      }
    } else if (!isTransitionAllowed(fromState, targetState)) {
      this.logger.error(
        `Illegal claim lifecycle transition ${fromState} -> ${targetState} ` +
          `for claim ${event.claimId} (tx ${event.txHash}); ignoring`,
      );
      return null;
    }

    const settledAt =
      targetState === ClaimState.Settled
        ? (current?.settledAt ?? event.blockTimestamp)
        : (current?.settledAt ?? null);

    const readModel =
      current ??
      this.readModelRepo.create({
        claimId: event.claimId,
        chainId: event.chainId,
        state: targetState,
        blockNumber: String(event.blockNumber),
        eventTxHash: event.txHash,
        eventIndex: event.eventIndex,
        stateChangedAt: event.blockTimestamp,
        settledAt: settledAt,
      });

    if (current) {
      readModel.state = targetState;
      readModel.blockNumber = String(event.blockNumber);
      readModel.eventTxHash = event.txHash;
      readModel.eventIndex = event.eventIndex;
      readModel.stateChangedAt = event.blockTimestamp;
      readModel.settledAt = settledAt;
    }

    await this.readModelRepo.save(readModel);
    return targetState;
  }

  /**
   * Idempotently persist a canonical event. Returns the stored entity, or
   * null if an equivalent or later event was already recorded.
   */
  private async persistEvent(
    event: CanonicalClaimEvent,
  ): Promise<ClaimLifecycleEvent | null> {
    const existing = await this.eventRepo.findOne({
      where: {
        claimId: event.claimId,
        blockNumber: String(event.blockNumber),
        eventIndex: event.eventIndex,
      },
    });
    if (existing) {
      return null;
    }

    const entity = this.eventRepo.create({
      type: event.type,
      claimId: event.claimId,
      chainId: event.chainId,
      blockNumber: String(event.blockNumber),
      eventIndex: event.eventIndex,
      logIndex: (event as { logIndex?: number }).logIndex ?? 0,
      txHash: event.txHash,
      actor: event.actor ?? null,
      payload: event.payload ?? null,
      blockTimestamp: event.blockTimestamp,
    });

    return this.eventRepo.save(entity);
  }

  /**
   * Rebuild a claim's read model from its full persisted event history.
   * Used for backfill and drift reconciliation.
   */
  async reproject(claimId: string, chainId: string): Promise<ClaimState> {
    const events = await this.eventRepo.find({
      where: { claimId, chainId },
      order: { blockNumber: 'ASC', eventIndex: 'ASC' },
    });

    let state: ClaimState = ClaimState.Submitted;
    let lastEvent: ClaimLifecycleEvent | undefined;

    for (const ev of events) {
      const target = EVENT_TYPE_TO_STATE[ev.type];
      if (!target) {
        continue;
      }
      if (isTransitionAllowed(state, target)) {
        state = target;
        lastEvent = ev;
      }
    }

    const readModel = await this.readModelRepo.findOne({
      where: { claimId, chainId },
    });
    const settledAt =
      state === ClaimState.Settled
        ? (readModel?.settledAt ?? lastEvent?.blockTimestamp ?? new Date())
        : null;

    const row =
      readModel ??
      this.readModelRepo.create({
        claimId,
        chainId,
        state,
        blockNumber: lastEvent?.blockNumber ?? String(0),
        eventTxHash: lastEvent?.txHash ?? '',
        eventIndex: lastEvent?.eventIndex ?? 0,
        stateChangedAt: lastEvent?.blockTimestamp ?? new Date(),
        settledAt,
      });

    if (readModel) {
      row.state = state;
      row.blockNumber = lastEvent?.blockNumber ?? String(0);
      row.eventTxHash = lastEvent?.txHash ?? '';
      row.eventIndex = lastEvent?.eventIndex ?? 0;
      row.stateChangedAt = lastEvent?.blockTimestamp ?? new Date();
      row.settledAt = settledAt;
    }

    await this.readModelRepo.save(row);
    return state;
  }

  /**
   * Expose the current projected read model for a claim.
   */
  async getReadModel(
    claimId: string,
    chainId: string,
  ): Promise<ClaimReadModel | null> {
    return this.readModelRepo.findOne({ where: { claimId, chainId } });
  }
}
