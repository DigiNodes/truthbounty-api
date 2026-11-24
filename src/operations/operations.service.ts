import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PublicErrorCode } from '../common/constants/error-codes';
import {
  OPERATIONS_AUDIT_STORE,
  OperationsAuditStore,
} from './operations-audit.store';
import {
  OPERATIONS_QUEUE_SOURCE,
  OperationsQueueSource,
  OperationsRetrySourceResult,
} from './operations-queue.source';
import {
  AuthoritySource,
  DuplicationRisk,
  OperationalAuditRecord,
  OperationalCapability,
  OperationalQueueItem,
  OperationalQueueSummary,
  QueueItemStatus,
  RetryDenialReason,
  RetryEligibility,
  RetrySubmission,
} from './operations.types';

/** Failure carrying a canonical code, an HTTP status and the request's audit id. */
export class OperationsError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: PublicErrorCode,
    readonly reason: RetryDenialReason | null,
    readonly auditId: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationsError';
  }
}

export interface SubmitRetryInput {
  id: string;
  preconditionToken?: string;
  idempotencyKey?: string;
  authorityCapability?: string;
  authorityExpiresAt?: string;
  actorId?: string;
  reason?: string;
  force?: boolean;
}

interface IdempotencyRecord {
  itemId: string;
  submission: RetrySubmission;
}

const CAPABILITY_HEADER = 'x-authority-capability';
const EXPIRY_HEADER = 'x-authority-expires-at';

/**
 * Protected operations, safe-retry and audit service (UX-BE-004, #595).
 *
 * Authorization is revalidated on every request (capability + expiry, fail
 * closed). Retries are idempotent and precondition-guarded, and never create a
 * new protocol mutation: they re-enqueue existing work through the queue
 * source, which carries its own deterministic idempotency key.
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);
  private readonly idempotency = new Map<string, IdempotencyRecord>();

  constructor(
    @Inject(OPERATIONS_QUEUE_SOURCE)
    private readonly source: OperationsQueueSource,
    @Inject(OPERATIONS_AUDIT_STORE)
    private readonly auditStore: OperationsAuditStore,
  ) {}

  static readonly capabilityHeader = CAPABILITY_HEADER;
  static readonly expiryHeader = EXPIRY_HEADER;

  async listQueue(): Promise<OperationalQueueSummary> {
    const items = await this.source.list();
    const countsByStatus = Object.values(QueueItemStatus).reduce(
      (acc, status) => {
        acc[status] = 0;
        return acc;
      },
      {} as Record<QueueItemStatus, number>,
    );
    for (const item of items) countsByStatus[item.status] += 1;

    return {
      releaseId: items[0]?.releaseId ?? 'unknown',
      generatedAt: new Date().toISOString(),
      total: items.length,
      countsByStatus,
      items,
    };
  }

  async getItem(id: string): Promise<OperationalQueueItem> {
    const item = await this.source.get(id);
    if (!item) {
      throw new OperationsError(
        404,
        PublicErrorCode.NOT_FOUND,
        null,
        randomUUID(),
        `Operational queue item ${id} was not found.`,
      );
    }
    return item;
  }

  async getRetryEligibility(id: string): Promise<RetryEligibility> {
    const item = await this.getItem(id);
    const reason = this.eligibilityReason(item);
    return {
      id: item.id,
      eligible: reason === null,
      reason,
      attemptsRemaining: Math.max(0, item.maxAttempts - item.attempts),
      preconditionToken: this.preconditionToken(item),
    };
  }

  async submitRetry(input: SubmitRetryInput): Promise<RetrySubmission> {
    const auditId = randomUUID();

    // Duplicate idempotency keys replay the original outcome and never
    // re-execute the retry.
    if (input.idempotencyKey) {
      const prior = this.idempotency.get(input.idempotencyKey);
      if (prior) {
        if (prior.itemId !== input.id) {
          await this.reject(
            auditId,
            'queue.retry',
            input,
            409,
            PublicErrorCode.CONFLICT,
            RetryDenialReason.CONFLICT,
            'Idempotency-Key was already used for a different item.',
            input.id,
          );
        }
        return prior.submission;
      }
    }

    const item = await this.source.get(input.id);
    if (!item) {
      return this.reject(
        auditId,
        'queue.retry',
        input,
        404,
        PublicErrorCode.NOT_FOUND,
        null,
        `Operational queue item ${input.id} was not found.`,
        input.id,
      );
    }

    // Authentication is not authorization: revalidate capability + expiry on
    // every request, fail closed.
    this.revalidateAuthority(auditId, item, input);

    // Precondition token must match the current version of the item.
    if (
      !input.preconditionToken ||
      input.preconditionToken !== this.preconditionToken(item)
    ) {
      await this.reject(
        auditId,
        'queue.retry',
        input,
        409,
        PublicErrorCode.STALE_PRECONDITION,
        RetryDenialReason.CONFLICT,
        'Precondition token is missing or stale; re-read the item and retry.',
        item.id,
      );
    }

    const reason = this.denialReason(item);
    if (reason !== null) {
      const { status, code, message } = this.denialResponse(reason);
      await this.reject(
        auditId,
        'queue.retry',
        input,
        status,
        code,
        reason,
        message,
        item.id,
      );
    }

    // A confirmed duplicate risk is never overridable by `force`.
    if (!item.retryable && !input.force) {
      await this.reject(
        auditId,
        'queue.retry',
        input,
        409,
        PublicErrorCode.NOT_RETRYABLE,
        RetryDenialReason.NOT_RETRYABLE,
        'This item is not eligible for retry.',
        item.id,
      );
    }

    let result: OperationsRetrySourceResult;
    try {
      result = await this.source.retry(item.id, {
        requestedBy: input.actorId,
        reason: input.reason,
        force: input.force,
      });
    } catch (error) {
      this.logger.error(
        `Operational retry dependency failed for ${item.id}: ${(error as Error).message}`,
      );
      return this.reject(
        auditId,
        'queue.retry',
        input,
        503,
        PublicErrorCode.DEPENDENCY_UNAVAILABLE,
        RetryDenialReason.UNAVAILABLE,
        'A required dependency is temporarily unavailable; retry later.',
        item.id,
      );
    }

    const submission: RetrySubmission = {
      id: item.id,
      accepted: true,
      auditId,
      replayed: result.replayed,
      skipped: result.skipped,
      failed: result.failed,
      detail: result.detail,
    };

    if (input.idempotencyKey) {
      this.idempotency.set(input.idempotencyKey, {
        itemId: item.id,
        submission,
      });
    }

    await this.auditStore.save(
      this.auditRecord(
        auditId,
        'queue.retry',
        input,
        'accepted',
        'ACCEPTED',
        item.id,
        item.capability,
        item.authoritySource,
      ),
    );

    return submission;
  }

  async getAuditRecord(auditId: string): Promise<OperationalAuditRecord> {
    const record = await this.auditStore.get(auditId);
    if (!record) {
      throw new OperationsError(
        404,
        PublicErrorCode.NOT_FOUND,
        null,
        auditId,
        `Audit record ${auditId} was not found.`,
      );
    }
    return record;
  }

  private revalidateAuthority(
    auditId: string,
    item: OperationalQueueItem,
    input: SubmitRetryInput,
  ): void {
    const capability = (input.authorityCapability ?? '').trim();
    if (capability === '' || capability !== String(item.capability)) {
      throw new OperationsError(
        403,
        PublicErrorCode.FORBIDDEN,
        RetryDenialReason.DENIED,
        auditId,
        'Caller authority does not grant the required capability.',
      );
    }

    const expiresAt = input.authorityExpiresAt;
    if (!expiresAt) {
      throw new OperationsError(
        403,
        PublicErrorCode.STALE_AUTHORITY,
        RetryDenialReason.STALE_AUTHORITY,
        auditId,
        'Caller authority has no expiry and cannot be trusted.',
      );
    }
    const expiresMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
      throw new OperationsError(
        403,
        PublicErrorCode.STALE_AUTHORITY,
        RetryDenialReason.STALE_AUTHORITY,
        auditId,
        'Caller authority is expired or ambiguous.',
      );
    }
  }

  private denialReason(item: OperationalQueueItem): RetryDenialReason | null {
    if (item.status === QueueItemStatus.COMPLETED) {
      return RetryDenialReason.ALREADY_COMPLETED;
    }
    if (item.status === QueueItemStatus.QUARANTINED) {
      return RetryDenialReason.UNSAFE_TO_RETRY;
    }
    if (item.duplicationRisk === DuplicationRisk.POSSIBLE) {
      return RetryDenialReason.UNSAFE_TO_RETRY;
    }
    return null;
  }

  /** Eligibility as shown to the frontend (includes plain non-retryable). */
  private eligibilityReason(
    item: OperationalQueueItem,
  ): RetryDenialReason | null {
    const hard = this.denialReason(item);
    if (hard !== null) return hard;
    if (!item.retryable) return RetryDenialReason.NOT_RETRYABLE;
    return null;
  }

  private denialResponse(reason: RetryDenialReason): {
    status: number;
    code: PublicErrorCode;
    message: string;
  } {
    switch (reason) {
      case RetryDenialReason.ALREADY_COMPLETED:
        return {
          status: 409,
          code: PublicErrorCode.ALREADY_COMPLETED,
          message: 'The operation is already completed and cannot be retried.',
        };
      case RetryDenialReason.UNSAFE_TO_RETRY:
        return {
          status: 409,
          code: PublicErrorCode.UNSAFE_TO_RETRY,
          message:
            'Retrying this item would risk duplicating an existing effect.',
        };
      case RetryDenialReason.NOT_RETRYABLE:
        return {
          status: 409,
          code: PublicErrorCode.NOT_RETRYABLE,
          message: 'This item is not eligible for retry.',
        };
      default:
        return {
          status: 409,
          code: PublicErrorCode.CONFLICT,
          message: 'The request conflicts with the current state of the item.',
        };
    }
  }

  private async reject(
    auditId: string,
    action: string,
    input: SubmitRetryInput,
    status: number,
    code: PublicErrorCode,
    reason: RetryDenialReason | null,
    message: string,
    subjectId: string | null,
  ): Promise<never> {
    await this.auditStore.save(
      this.auditRecord(auditId, action, input, 'rejected', code, subjectId),
    );
    throw new OperationsError(status, code, reason, auditId, message);
  }

  private auditRecord(
    auditId: string,
    action: string,
    input: SubmitRetryInput,
    outcome: 'accepted' | 'rejected',
    resultCode: string,
    subjectId: string | null,
    capability: OperationalCapability = OperationalCapability.RETRY_SUBMIT,
    authoritySource: AuthoritySource = AuthoritySource.SYSTEM,
  ): OperationalAuditRecord {
    return {
      auditId,
      action,
      capability,
      authoritySource,
      actorId: input.actorId ?? null,
      outcome,
      resultCode,
      subjectId,
      createdAt: new Date().toISOString(),
    };
  }

  private preconditionToken(item: OperationalQueueItem): string {
    return createHash('sha256')
      .update(`${item.id}:${item.version}:${item.status}:${item.releaseId}`)
      .digest('hex')
      .slice(0, 32);
  }
}
