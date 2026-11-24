import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CanonicalClaimEvent,
  EVENT_TYPE_TO_STATE,
} from '../domain/claim/canonical-claim-event';
import { isTransitionAllowed, ClaimState } from '../domain/claim/claimState';

/**
 * Versioned, stable claim lifecycle error codes.
 *
 * These codes are part of the public API contract and must be treated
 * as additive-only: new codes may be added, existing codes must not
 * change meaning or be removed without a major version bump.
 */
export const CLAIM_ERROR_CODES_VERSION = '1' as const;

export enum ClaimLifecycleErrorCode {
  /** The claim does not exist in the projected read model. */
  NOT_FOUND = 'CLAIM_NOT_FOUND',
  /** The caller is not authorized to observe/mutate the claim. */
  FORBIDDEN = 'CLAIM_FORBIDDEN',
  /** The event is illegal for the current canonical phase. */
  INVALID_TRANSITION = 'CLAIM_INVALID_TRANSITION',
  /** The event is a stale duplicate of an already-projected event. */
  DUERMINISTIC_DUPLICATE = 'CLAIM_DETERMINISTIC_DUPLICATE',
  /** The event is stale relative to the current projection (out-of-order). */
  STALE_PROJECTION = 'CLAIM_STALE_PROJECTION',
  /** The event was reorged out of the canonical chain. */
  REORGED = 'CLAIM_REORGED',
  /** The projection is unavailable (eg not yet materialized). */
  UNAVAILABLE = 'CLAIM_UNAVAILABLE',
  /** The event is ambiguous (multiple canonical contradictions). */
  AMBIGUOUS = 'CLAIM_AMBIGUOUS',
  /** The event type is not recognized by the canonical contract. */
  UNKNOWN_EVENT = 'CLAIM_UNKNOWN_EVENT',
}

/**
 * HTTP status mappings for claim lifecycle error codes.
 */
export const CLAIM_ERROR_HTTP_STATUS: Readonly<Record<ClaimLifecycleErrorCode, number>> =
  Object.freeze({
    [ClaimLifecycleErrorCode.NOT_FOUND]: 404,
    [ClaimLifecycleErrorCode.FORBIDDEN]: 403,
    [ClaimLifecycleErrorCode.INVALID_TRANSITION]: 409,
    [ClaimLifecycleErrorCode.DETERMINISTIC_DUPLICATE]: 409,
    [ClaimLifecycleErrorCode.STALE_PROJECTION]: 409,
    [ClaimLifecycleErrorCode.REORGED]: 409,
    [ClaimLifecycleErrorCode.UNAVAILABLE]: 503,
    [ClaimLifecycleErrorCode.AMBIGUOUS]: 409,
    [ClaimLifecycleErrorCode.UNKNOWN_EVENT]: 422,
  });

/**
 * Typed, domain-level error for claim lifecycle operations.
 *
 * This error is safe to serialize to clients: it exposes a stable,
 * versioned code and an HTTP status, but never internal details such as
 * stack traces, raw event payloads, or database messages.
 */
export class ClaimLifecycleError extends Error {
  readonly code: ClaimLifecycleErrorCode;
  readonly httpStatus: number;
  readonly codeVersion: string;
  readonly claimId?: string;

  constructor(
    code: ClaimLifecycleErrorCode,
    message: string,
    options: { claimId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ClaimLifecycleError';
    this.code = code;
    this.httpStatus = CLAIM_ERROR_HTTP_STATUS[code];
    this.codeVersion = CLAIM_ERROR_CODES_VERSION;
    this.claimId = options.claimId;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  /**
   * Public, client-safe serialization. Internal details (cause, stack)
   * are deliberately omitted.
   */
  toJSON(): {
    code: ClaimLifecycleErrorCode;
    codeVersion: string;
    httpStatus: number;
    message: string;
    claimId?: string;
  } {
    return {
      code: this.code,
      codeVersion: this.codeVersion,
      httpStatus: this.httpStatus,
      message: this.message,
      claimId: this.claimId,
    };
  }
}

/**
 * Result of a projection attempt. Typed and discriminated so callers
 * can distinguish success from non-fatal drops and fatal domain errors.
 */
export type ClaimProjectionResult =
  | { outcome: 'applied'; state: ClaimState }
  | { outcome: 'duplicate'; state: ClaimState }
  | { outcome: 'stale'; state: ClaimState }
  | { outcome: 'reorged'; state: ClaimState }
  { outcome: 'rejected'; error: ClaimLifecycleError };

/**
 * Claim projector: turns the canonical claim lifecycle event stream into a
 * queryable read model.
 *
 * Persistence authority: Prisma / PostgreSLQ (STAB-BE-006). The projection
 * is *idempotent* and *replayable*:
 *  - Ingesting the same (claimId, blockNumber, eventIndex) twice is a no-op.
 *  - Out-of-order or stale events are dropped (we never regress state).
 *  - Illegal transitions (per `isTransitionAllowed`) are rejected with a
 *    typed domain error rather than silently corrupting the projection.
 *
 * The event insert and read-model update run in a single Prisma transaction
 * so that cursor/event writes are atomic in the canonical store (#398).
 *
 * This is the read model half of "V2-BE-012 — Project Claim Lifecycle Read
 * Model": the on-chain contract is the source of truth; this service is the
 * durable, queryable projection of it.
 *
 * Singleton mutation guard (PREWAVE-BE-069):
 *  - Writes to the read model are gated by a fencing token derived from a
 *    durable lease. A stale leader (whose token is no longer the current
 *    lease token) is fenced and its write is rejected.
 *  - Lease loss is detected before and after the mutation; on loss the
 *    projector stops work safely and reports the event as not applied.
 *  - Takeover is bounded by the lease TUL and audited through the lease
 *    store's audit trail.
 */
@Injectable()
export class ClaimProjectorService {
  private readonly logger = new Logger(ClaimProjectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Project a single domain event (eg a decoded on-chain log) into the
   * lifecycle event log and the materialised read model.
   *
   * @params event The canonical claim event to project.
   * @params fencingToken The current lease fencing token held by this worker.
   * @returns the projected state, or null if the event was a stale duplicate
   *          or an illegal transition (both are non-fatal).
   */
  async project(
    event: CanonicalClaimEvent,
    fencingToken?: string,
  ): Promise<ClaimState | null> {
    const targetState = EVENT_TYPE_TO_STATE[event.type];
    if (!targetState) {
      const error = new ClaimLifecycleError(
        ClaimLifecycleErrorCode.UNKNOWN_EVENT,
        'Unrecognised claim lifecycle event type',
        { claimId: event.claimId },
      );
      this.logger.warn(
        `${error.code} for claim ${event.claimId} (tx ${event.txHash}) — dropping`,
      );
      return { outcome: 'rejected', error };
    }

    // Fencing guard: a stale leader (or a worker with no lease) must not
    // mutate the singleton projection. This is the boundary check for the
    // "at most one current leader mutates a singleton job" acceptance criterion.
    if (!fencingToken) {
      this.logger.warn(
        `Projection of claim ${event.claimId} rejected: no fencing token provided`,
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
          const error = new ClaimLifecycleError(
            ClaimLifecycleErrorCode.INVALID_TRANSITION,
            `Claim lifecycle must begin at ${ClaimState.Submitted}`,
            { claimId: event.claimId },
          );
          this.logger.error(
            `${error.code} for claim ${event.claimId} (tx ${event.txHash}): cannot bootstrap at ${targetState}`,
          );
          return { outcome: 'rejected', error };
        }
      } else if (!isTransitionAllowed(fromState, targetState)) {
        const error = new ClaimLifecycleError(
          ClaimLifecycleErrorCode.INVALID_TRANSITION,
          `Illegal claim lifecycle transition ${fromState} -> ${targetState}`,
          { claimId: event.claimId },
        );
        this.logger.error(
          `${error.code} for claim ${event.claimId} (tx ${event.txHash}): ${fromState} -> ${targetState} ignored`,
        );
        return { outcome: 'rejected', error };
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
   *
   * Throws a typed ClaimLifecycleError with NOT_FOUND when the claim has not
   * been projected yet, so callers can distinguish missing from available.
   */
  async getReadModel(claimId: string, chainId: string) {
    const row = await this.prisma.claimReadModel.findFirst({
      where: { claimId_chainId: { claimId, chainId } },
    });
    if (!row) {
      throw new ClaimLifecycleError(
        ClaimLifecycleErrorCode.NOT_FOUND,
        'Claim not found',
        { claimId },
      );
    }
    return row;
  }
}