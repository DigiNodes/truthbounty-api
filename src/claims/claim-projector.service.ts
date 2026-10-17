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
 * The projector is *idempotent* and *replayable*:
 *  - Ingesting the same (claimId, blockNumber, eventIndex) twice is a no-op.
 *  - Out-of-order or stale events are dropped (we never regress state).
 *  - Illegal transitions (per `isTransitionAllowed`) are rejected with a
 *    typed domain error rather than silently corrupting the projection.
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
   * Project a single domain event (eg a decoded on-chain log) into the
   * lifecycle event log and the materialised read model.
   *
   * Returns a typed result:
   *  - `applied`     the event was applied to the read model.
   *  - `duplicate`    the event was already recorded (idempotent no-op).
   *  - `stale`       the event is older than the current projection.
   *  - `reorged`     the event was reorged out of the canonical chain.
   *  - `rejected`     the event is illegal for the current phase.
   */
  async project(event: CanonicalClaimEvent): Promise<ClaimProjectionResult> {
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

    const persisted = await this.persistEvent(event);
    if (persisted.outcome === 'stale') {
      const current = await this.readModelRepo.findOne({
        where: { claimId: event.claimId, chainId: event.chainId },
      });
      return { outcome: 'stale', state: current?.state ?? ClaimState.Submitted };
    }
    if (persisted.outcome === 'duplicate') {
      const current = await this.readModelRepo.findOne({
        where: { claimId: event.claimId, chainId: event.chainId },
      });
      return {
        outcome: 'update' in persisted ? 'update' : 'duplicate',
        state: current?.state ?? ClaimState.Submitted,
      } as ClaimProjectionResult;
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

    const settledAt =
      targetState === ClaimState.Settled
        ? (current?.settledAt ?? event.blockTimestamp)
        : (current?.settledAt ?? null);

    const readModel =
      current ?? this.readModelRepo.create({
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
    return { outcome: 'applied', state: targetState };
  }

  /**
   * Idempotently persist a canonical event.
   *
   * Returns `duplicate` when an exact equivalent event is already recorded,
   * `stale` when a later event for the claim is already recorded, otherwise
   * `persisted` with the stored entity.
   */
  private async persistEvent(event: CanonicalClaimEvent): Promise<{
    outcome: 'persisted' | 'update' | 'duplicate' | 'stale';
    entity?: ClaimLifecycleEvent;
  }> {
    const existing = await this.eventRepo.findOne({
      where: {
        claimId: event.claimId,
        blockNumber: String(event.blockNumber),
        eventIndex: event.eventIndex,
      },
    });
    if (existing) {
      return { outcome: 'update' };
    }

    // Reject out-of-order events that would regress the persisted canonical
    // history. This keeps the event log append-only and monotonic.
    const latest = await this.eventRepo.findOne({
      where: { claimId: event.claimId, chainId: event.chainId },
      order: { blockNumber: 'DESC', eventIndex: 'DESC' },
    });
    if (latest) {
      const latestBlock = BigInt(latest.blockNumber);
      const incomingBlock = BigInt(String(event.blockNumber));
      if (
        incomingBlock < latestBlock ||
        (incomingBlock === latestBlock && event.eventIndex <= latest.eventIndex)
      ) {
        return { outcome: 'stale' };
      }
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

    const saved = await this.eventRepo.save(entity);
    return { outcome: 'persisted', entity: saved };
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
   *
   * Throws a typed ClaimLifecycleError with NOT_FOUND when the claim has not
   * been projected yet, so callers can distinguish missing from available.
   */
  async getReadModel(
    claimId: string,
    chainId: string,
  ): Promise<ClaimReadModel> {
    const row = await this.readModelRepo.findOne({
      where: { claimId, chainId },
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
