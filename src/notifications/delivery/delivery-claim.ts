import { randomUUID } from 'crypto';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import {
  DeliveryClaimContext,
  DeliveryClaimResult,
  DeliveryStatus,
} from '../interfaces/notification.types';
import { buildDeliveryIdempotencyKey } from './delivery-idempotency-key';

/** Short lease for a worker that claimed but has not called the provider yet. */
export const DEFAULT_CLAIM_TTL_MS = 60_000;

/**
 * Lease applied when a provider accepted (or may have accepted) a delivery but
 * the worker died before the durable confirmation. A recovery worker may only
 * re-claim after this window, and must reuse the same provider idempotency key.
 */
export const DEFAULT_UNCERTAIN_CLAIM_TTL_MS = 5 * 60_000;

const RECLAIMABLE_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.PENDING,
  DeliveryStatus.PROCESSING,
  DeliveryStatus.FAILED,
  DeliveryStatus.EXPIRED,
  DeliveryStatus.RETRYING,
];

export interface ClaimRepository {
  insert?: (entity: Record<string, unknown>) => Promise<unknown>;
  create?: (entity: Record<string, unknown>) => DeliveryHistory;
  save?: (entity: unknown) => Promise<DeliveryHistory>;
  findOne?: (options: unknown) => Promise<DeliveryHistory | null>;
  find?: (options: unknown) => Promise<DeliveryHistory[]>;
  update?: (
    criteria: Record<string, unknown>,
    partial: Record<string, unknown>,
  ) => Promise<{ affected?: number | null }>;
  createQueryBuilder?: (alias?: string) => any;
  manager?: {
    transaction?: <T>(callback: (manager: any) => Promise<T>) => Promise<T>;
  };
}

export function resolveDeliveryKey(context: DeliveryClaimContext): string {
  if (context.idempotencyKey) {
    return context.idempotencyKey;
  }

  if (!context.eventType || !context.recipientId || !context.channel) {
    throw new Error(
      'idempotencyKey or eventType+recipientId+channel is required for a delivery claim',
    );
  }

  return buildDeliveryIdempotencyKey({
    eventType: context.eventType,
    recipientId: context.recipientId,
    channel: context.channel,
    aggregateId: context.aggregateId,
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === '23505' ||
    /unique|duplicate key/i.test(candidate.message ?? '')
  );
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isReclaimable(
  history: DeliveryHistory | null,
  now: Date = new Date(),
): boolean {
  if (!history) return true;
  if (
    history.status === DeliveryStatus.DELIVERED ||
    history.status === DeliveryStatus.PERMANENT_FAILURE
  ) {
    return false;
  }

  if (!RECLAIMABLE_STATUSES.includes(history.status)) {
    return false;
  }

  const nextAttemptAt = asDate(history.nextAttemptAt);
  if (nextAttemptAt && nextAttemptAt > now) return false;

  if (history.status === DeliveryStatus.PROCESSING) {
    const expiry = asDate(history.claimExpiresAt);
    return !expiry || expiry <= now;
  }

  return true;
}

async function tryInsertClaim(
  repository: ClaimRepository,
  row: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (typeof repository.insert === 'function') {
      await repository.insert(row);
      return true;
    }
    if (repository.create && repository.save) {
      await repository.save(repository.create(row));
      return true;
    }
    return false;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

function deniedResult(
  idempotencyKey: string,
  history: DeliveryHistory | null,
): DeliveryClaimResult {
  if (history?.status === DeliveryStatus.DELIVERED) {
    return {
      acquired: false,
      idempotencyKey,
      status: DeliveryStatus.DELIVERED,
      reason: 'delivered',
    };
  }
  if (history?.status === DeliveryStatus.PERMANENT_FAILURE) {
    return {
      acquired: false,
      idempotencyKey,
      status: DeliveryStatus.PERMANENT_FAILURE,
      reason: 'permanent_failure',
    };
  }
  if (history?.nextAttemptAt && asDate(history.nextAttemptAt)! > new Date()) {
    return {
      acquired: false,
      idempotencyKey,
      status: history.status,
      reason: 'retry_wait',
    };
  }
  return {
    acquired: false,
    idempotencyKey,
    status: history?.status ?? 'absent',
    reason: 'in_progress',
  };
}

/**
 * Atomically acquire the durable delivery claim.
 *
 * A unique insert wins for a brand-new key. For an existing key, a conditional
 * UPDATE guarded by status, lease expiry and the previous fencing token is the
 * correctness boundary: at most one worker can flip a row to PROCESSING.
 */
export async function acquireDeliveryClaim(
  repository: ClaimRepository,
  context: DeliveryClaimContext,
): Promise<DeliveryClaimResult> {
  const idempotencyKey = resolveDeliveryKey(context);
  const now = new Date();
  const claimId = randomUUID();
  const claimTtlMs = context.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const uncertainTtlMs =
    context.uncertainTtlMs ?? DEFAULT_UNCERTAIN_CLAIM_TTL_MS;

  const inserted = await tryInsertClaim(repository, {
    notificationId: context.notificationId ?? idempotencyKey,
    recipientId: context.recipientId,
    eventType: context.eventType,
    aggregateId: context.aggregateId,
    channel: context.channel,
    status: DeliveryStatus.PROCESSING,
    retryAttempts: 0,
    providerUnconfirmed: context.providerUnconfirmed ?? false,
    idempotencyKey,
    claimId,
    claimedAt: now,
    claimExpiresAt: new Date(
      now.getTime() +
        (context.providerUnconfirmed ? uncertainTtlMs : claimTtlMs),
    ),
    nextAttemptAt: null,
  });

  if (inserted) {
    return {
      acquired: true,
      idempotencyKey,
      claimId,
      status: DeliveryStatus.PROCESSING,
      reason: 'acquired',
    };
  }

  const history = await repository.findOne?.({
    where: { idempotencyKey },
  });

  if (!history) {
    return deniedResult(idempotencyKey, null);
  }
  if (!isReclaimable(history, now)) {
    return deniedResult(idempotencyKey, history);
  }

  const providerUnconfirmed = history.providerUnconfirmed === true;
  const claimUpdate: Record<string, unknown> = {
    status: DeliveryStatus.PROCESSING,
    claimId,
    claimedAt: now,
    claimExpiresAt: new Date(
      now.getTime() + (providerUnconfirmed ? uncertainTtlMs : claimTtlMs),
    ),
    providerUnconfirmed,
    failureReason: null,
    nextAttemptAt: null,
  };

  let claimed = false;
  if (typeof repository.createQueryBuilder === 'function') {
    const result = await repository
      .createQueryBuilder('delivery')
      .update(DeliveryHistory)
      .set(claimUpdate)
      .where('idempotencyKey = :idempotencyKey', { idempotencyKey })
      .andWhere('status IN (:...statuses)', {
        statuses: RECLAIMABLE_STATUSES,
      })
      .andWhere('(claimExpiresAt IS NULL OR claimExpiresAt <= :now)', { now })
      .andWhere('(nextAttemptAt IS NULL OR nextAttemptAt <= :now)', { now })
      .execute();
    claimed = (result?.affected ?? 0) > 0;
  } else if (repository.update) {
    const result = await repository.update(
      {
        id: history.id,
        status: history.status,
        claimId: history.claimId ?? null,
      },
      claimUpdate,
    );
    claimed = (result?.affected ?? 0) > 0;
  }

  if (!claimed) {
    const latest = await repository.findOne?.({
      where: { idempotencyKey },
    });
    return deniedResult(idempotencyKey, latest ?? history);
  }

  return {
    acquired: true,
    idempotencyKey,
    claimId,
    status: DeliveryStatus.PROCESSING,
    reason: 'acquired',
  };
}

export class DeliveryClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryClaimConflictError';
  }
}

async function settleClaim(
  repository: ClaimRepository,
  idempotencyKey: string,
  claimId: string | undefined,
  update: Record<string, unknown>,
): Promise<DeliveryHistory | null> {
  const now = new Date();
  let affected = 0;

  const isDeliveryConfirmation = update.status === DeliveryStatus.DELIVERED;

  if (typeof repository.createQueryBuilder === 'function') {
    const result = await repository
      .createQueryBuilder('delivery')
      .update(DeliveryHistory)
      .set({ ...update, updatedAt: now })
      .where('idempotencyKey = :idempotencyKey', { idempotencyKey })
      .andWhere(
        isDeliveryConfirmation
          ? '(claimId = :claimId OR status = :delivered)'
          : 'claimId = :claimId',
        {
          claimId: claimId ?? '',
          delivered: DeliveryStatus.DELIVERED,
        },
      )
      .execute();
    affected = result?.affected ?? 0;
  } else if (repository.update) {
    const result = await repository.update(
      {
        idempotencyKey,
        ...(claimId ? { claimId } : {}),
      },
      { ...update, updatedAt: now },
    );
    affected = result?.affected ?? 0;
  }

  const history = await repository.findOne?.({
    where: { idempotencyKey },
  });

  if (affected > 0) {
    return history ?? null;
  }

  if (history?.status === DeliveryStatus.DELIVERED) {
    return history;
  }
  if (!history && update.status === DeliveryStatus.DELIVERED) {
    await tryInsertClaim(repository, {
      ...update,
      idempotencyKey,
      notificationId: idempotencyKey,
      retryAttempts: 0,
      updatedAt: now,
    });
    return null;
  }

  throw new DeliveryClaimConflictError(
    `Delivery claim for ${idempotencyKey} is held by another worker`,
  );
}

export async function confirmDeliveryClaim(
  repository: ClaimRepository,
  idempotencyKey: string,
  claimId?: string,
  metadata?: Record<string, unknown>,
): Promise<DeliveryHistory | null> {
  return settleClaim(repository, idempotencyKey, claimId, {
    status: DeliveryStatus.DELIVERED,
    deliveredAt: new Date(),
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    providerUnconfirmed: false,
    failureReason: null,
    nextAttemptAt: null,
    ...(metadata ? { metadata } : {}),
  });
}

/** Definite provider failure: release the lease and make the row retryable. */
export async function failDeliveryClaim(
  repository: ClaimRepository,
  idempotencyKey: string,
  claimId: string | undefined,
  failureReason: string,
  terminal = false,
): Promise<DeliveryHistory | null> {
  const now = new Date();
  return settleClaim(repository, idempotencyKey, claimId, {
    status: terminal ? DeliveryStatus.PERMANENT_FAILURE : DeliveryStatus.FAILED,
    failureReason,
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    providerUnconfirmed: false,
    nextAttemptAt: terminal ? null : now,
  });
}

/** Mark a retry as scheduled without pretending the provider was called again. */
export async function retryDeliveryClaim(
  repository: ClaimRepository,
  idempotencyKey: string,
  claimId: string | undefined,
  retryAttempt: number,
  failureReason?: string,
): Promise<DeliveryHistory | null> {
  const now = new Date();
  return settleClaim(repository, idempotencyKey, claimId, {
    status: DeliveryStatus.RETRYING,
    retryAttempts: retryAttempt,
    lastRetryAt: now,
    nextAttemptAt: now,
    failureReason: failureReason ?? null,
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    providerUnconfirmed: false,
  });
}

/**
 * Provider outcome is unknown (timeout, connection reset, crash after accept).
 * The row stays PROCESSING with a longer lease and a `providerUnconfirmed`
 * marker. No other worker may send until that lease expires, and recovery must
 * reuse the same provider idempotency key.
 */
export async function markDeliveryClaimUncertain(
  repository: ClaimRepository,
  idempotencyKey: string,
  claimId: string | undefined,
  reason: string,
  uncertainTtlMs: number = DEFAULT_UNCERTAIN_CLAIM_TTL_MS,
): Promise<DeliveryHistory | null> {
  return settleClaim(repository, idempotencyKey, claimId, {
    status: DeliveryStatus.PROCESSING,
    providerUnconfirmed: true,
    failureReason: reason,
    claimId: null,
    claimedAt: null,
    claimExpiresAt: new Date(Date.now() + uncertainTtlMs),
    nextAttemptAt: null,
  });
}

export async function expireStaleDeliveryClaims(
  repository: ClaimRepository,
  now: Date = new Date(),
): Promise<number> {
  const expiredUpdate = {
    status: DeliveryStatus.EXPIRED,
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
  };

  if (typeof repository.createQueryBuilder === 'function') {
    const result = await repository
      .createQueryBuilder('delivery')
      .update(DeliveryHistory)
      .set(expiredUpdate)
      .where('status = :status', { status: DeliveryStatus.PROCESSING })
      .andWhere('claimExpiresAt IS NOT NULL')
      .andWhere('claimExpiresAt <= :now', { now })
      .execute();
    return result?.affected ?? 0;
  }

  if (repository.find && repository.update) {
    const processing = await repository.find({
      where: { status: DeliveryStatus.PROCESSING },
    });
    let expired = 0;
    for (const row of processing) {
      const expiry = asDate(row.claimExpiresAt);
      if (!expiry || expiry > now) continue;
      const result = await repository.update(
        {
          id: row.id,
          status: DeliveryStatus.PROCESSING,
          claimId: row.claimId ?? null,
        },
        expiredUpdate,
      );
      expired += result?.affected ?? 0;
    }
    return expired;
  }

  return 0;
}
