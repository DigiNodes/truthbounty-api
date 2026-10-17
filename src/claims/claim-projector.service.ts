import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CanonicalClaimEvent,
  EVENT_TYPE_TO_STATE,
} from '../domain/claim/canonical-claim-event';
import { isTransitionAllowed, ClaimState } from '../domain/claim/claimState';

/**
 * Claim projector: turns the canonical claim lifecycle event stream into a
 * queryable read model.
 *
 * Persistence authority: Prisma / PostgreSLQ (STAB-BE-006). The projection
 * is *idempotent* and *replayable*:
 *  - Ingesting the same (claimId, blockNumber, eventIndex) twice is a no-op.
 *  - Out-of-order or stale events are dropped (we never regress state).
 *  - Illegal transitions (per `isTransitionAllowed`) are rejected and logged
 *    rather than silently corrupting the projection.
 *
 * The event insert and read-model update run in a single Prisma transaction
 * so that cursor/event writes are atomic in the canonical store (#398).
 *
 * This is the read model half of "V2-BE-012 — Project Claim Lifecycle Read
 * Model": the on-chain contract is the source of truth; this service is the
 * durable, queryable projection of it.
 */
@Injectable()
export class ClaimProjectorService {
  private readonly logger = new Logger(ClaimProjectorService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.claimLifecycleEvent.findFirst({
        where: {
          claimId: event.claimId,
          blockNumber: String(event.blockNumber),
          eventIndex: event.eventIndex,
        },
      });
      if (existing) {
        // Duplicate (or earlier) event already recorded — nothing new to apply.
        return null;
      }

      const current = await tx.claimReadModel.findFirst({
        where: { claimId: event.claimId, chainId: event.chainId },
      });

      const fromState: ClaimState = (current?.state as ClaimState) ?? ClaimState.Submitted;

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

      await tx.claimLifecycleEvent.create({
        data: {
          type: event.type,
          claimId: event.claimId,
          chainId: event.chainId,
          blockNumber: String(event.blockNumber),
          eventIndex: event.eventIndex,
          logIndex: (event as { logIndex?: number }).logIndex ?? 0,
          txHash: event.txHash,
          actor: event.actor ?? null,
          payload: (event.payload ?? undefined) as unknown,
          blockTimestamp: event.blockTimestamp,
        },
      });

      const settledAt =
        targetState === ClaimState.Settled
          ? (current?.settledAt ?? event.blockTimestamp)
          : (current?.settledAt ?? null);

      const data = {
        state: targetState,
        blockNumber: String(event.blockNumber),
        eventTxHash: event.txHash,
        eventIndex: event.eventIndex,
        stateChangedAt: event.blockTimestamp,
        settledAt,
      };

      await tx.claimReadModel.upsert({
        where: {
          claimId_chainId: {
            claimId: event.claimId,
            chainId: event.chainId,
          },
        },
        create: {
          claimId: event.claimId,
          chainId: event.chainId,
          ...data,
        },
        update: data,
      });

      return targetState;
    });
  }

  /**
   * Rebuild a claim's read model from its full persisted event history.
   * Used for backfill and drift reconciliation.
   */
  async reproject(claimId: string, chainId: string): Promise<ClaimState> {
    return this.prisma.$transaction(async (tx) => {
      const events = await tx.claimLifecycleEvent.findMany({
        where: { claimId, chainId },
        orderBy: [{ blockNumber: 'asc' }, { eventIndex: 'asc' }],
      });

      let state: ClaimState = ClaimState.Submitted;
      let lastEvent: (typeof events)[number] | undefined;

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

      const readModel = await tx.claimReadModel.findFirst({
        where: { claimId, chainId },
      });
      const settledAt =
        state === ClaimState.Settled
          ? (readModel?.settledAt ?? lastEvent?.blockTimestamp ?? new Date())
          : null;

      const data = {
        state,
        blockNumber: lastEvent?.blockNumber ?? String(0),
        eventTxHash: lastEvent?.txHash ?? '',
        eventIndex: lastEvent?.eventIndex ?? 0,
        stateChangedAt: lastEvent?.blockTimestamp ?? new Date(),
        settledAt,
      };

      await tx.claimReadModel.upsert({
        where: { claimId_chainId: { claimId, chainId } },
        create: { claimId, chainId, ...data },
        update: data,
      });

      return state;
    });
  }

  /**
   * Expose the current projected read model for a claim.
   */
  async getReadModel(claimId: string, chainId: string) {
    return this.prisma.claimReadModel.findFirst({
      where: { claimId_chainId: { claimId, chainId } },
    });
  }
}
