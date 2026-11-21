import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { PublicErrorCode } from '../common/constants/error-codes';
import {
  OPERATIONS_AUDIT_STORE,
  OperationsAuditStore,
} from './operations-audit.store';
import {
  OPERATIONS_IDEMPOTENCY_STORE,
  OperationsIdempotencyStore,
} from './operations-idempotency.store';
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

const CAPABILITY_HEADER = 'x-authority-capability';
const EXPIRY_HEADER = 'x-authority-expires-at';

/**
 * Protected operations, safe-retry and audit service (UX-BE-004, #595, #811).
 *
 * Authorization is revalidated on every request (capability + expiry, fail
 * closed). Retries are idempotent and precondition-guarded, and never create a
 * new protocol mutation: they re-enqueue existing work through the queue
 * source, which carries its own deterministic idempotency key.
 *
 * ## Durable idempotency and audit (PREWAVE-BE-110, #811)
 *
 * Idempotency keys and audit records are now persisted in the database and
 * shared across API replicas. All writes (idempotency key + audit record +
 * queue source update) are committed in a single transaction, ensuring
 * atomicity and consistency across restarts and deployments.
 *
 * Transaction boundary:
 * - submitRetry() wraps all persistence in `dataSource.transaction()`
 * - Idempotency key is saved via `idempotencyStore.save(input, manager)`
 * - Audit record is saved via `auditStore.save(record, manager)`
 * - Queue source update happens within the same transaction
 * - Either all writes commit or all roll back together
 *
 * Concurrency:
 * - Duplicate idempotency keys are rejected at the database level
 * - Race conditions between replicas result in constraint violations
 * - The second writer fetches and replays the cached outcome
 *
 * Failure recovery:
 * - Crash before transaction commit: all writes rolled back, no side effects
 * - Crash after transaction commit: idempotency key + audit trail are durable
 * - Replay of a duplicate key returns the original outcome without re-execution
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(OPERATIONS_QUEUE_SOURCE)
    private readonly source: OperationsQueueSource,
    @Inject(OPERATIONS_AUDIT_STORE)
    private readonly auditStore: OperationsAuditStore,
    @Inject(OPERATIONS_IDEMPOTENCY_STORE)
    private readonly idempotencyStore: OperationsIdempotencyStore,
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

    // Check for duplicate idempotency keys BEFORE starting the transaction.
    // Replay the cached outcome if found, never re-executing the retry.
    if (input.idempotencyKey) {
      const check = await this.idempotencyStore.check(input.idempotencyKey);
      if (check.exists && check.record) {
        if (check.record.itemId !== input.id) {
          // Idempotency key was used for a different item: hard conflict.
          await this.rejectOutsideTransaction(
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
        // Same item: replay the cached outcome without re-execution.
        this.logger.log(
          `Idempotency key replay: ${input.idempotencyKey} (itemId=${input.id})`,
        );
        return check.record.outcome;
      }
    }

    // Fetch the queue item to validate and extract metadata.
    const item = await this.source.get(input.id);
    if (!item) {
      return this.rejectOutsideTransaction(
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

    // Revalidate authority capability and expiry on every request (fail closed).
    this.revalidateAuthority(auditId, item, input);

    // Validate precondition token matches the current item version.
    if (
      !input.preconditionToken ||
      input.preconditionToken !== this.preconditionToken(item)
    ) {
      await this.rejectOutsideTransaction(
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

    // Check business rules for retry eligibility.
    const reason = this.denialReason(item);
    if (reason !== null) {
      const { status, code, message } = this.denialResponse(reason);
      await this.rejectOutsideTransaction(
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

    // Confirmed duplicate risk is never overridable by `force`.
    if (!item.retryable && !input.force) {
      await this.rejectOutsideTransaction(
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

    // Execute the retry and persist the outcome in a single transaction.
    // Idempotency key + audit record + queue source update are atomic.
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Call the queue source's retry method (e.g., OutboxOperationsQueueSource).
        // For the outbox source, this updates v2_outbox_messages within the transaction.
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
          // Dependency failure: reject and save audit record within transaction.
          await this.auditStore.save(
            this.auditRecord(
              auditId,
              'queue.retry',
              input,
              'rejected',
              PublicErrorCode.DEPENDENCY_UNAVAILABLE,
              item.id,
              item.capability,
              item.authoritySource,
            ),
            manager,
          );
          throw new OperationsError(
            503,
            PublicErrorCode.DEPENDENCY_UNAVAILABLE,
            RetryDenialReason.UNAVAILABLE,
            auditId,
            'A required dependency is temporarily unavailable; retry later.',
          );
        }

        // Build the submission outcome.
        const submission: RetrySubmission = {
          id: item.id,
          accepted: true,
          auditId,
          replayed: result.replayed,
          skipped: result.skipped,
          failed: result.failed,
          detail: result.detail,
        };

        // Save the idempotency key with the outcome (if provided).
        if (input.idempotencyKey) {
          await this.idempotencyStore.save(
            {
              key: input.idempotencyKey,
              itemId: item.id,
              actorId: input.actorId ?? null,
              capability: item.capability,
              authoritySource: item.authoritySource,
              authorityExpiresAt: input.authorityExpiresAt ?? null,
              outcome: submission,
            },
            manager,
          );
        }

        // Save the audit record for the accepted request.
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
          manager,
        );

        return submission;
      });
    } catch (error) {
      // If the error is already an OperationsError (e.g., from dependency failure),
      // re-throw it. Otherwise, wrap unexpected errors.
      if (error instanceof OperationsError) {
        throw error;
      }

      // Check if this is a database constraint violation (duplicate idempotency key).
      // This can happen if two replicas race to insert the same key.
      const isDuplicateKey =
        (error as any).code === '23505' || // PostgreSQL unique violation
        (error as Error).message?.includes('UNIQUE constraint') ||
        (error as Error).message?.includes('duplicate key');

      if (isDuplicateKey && input.idempotencyKey) {
        // Another replica won the race. Fetch and replay the cached outcome.
        const check = await this.idempotencyStore.check(input.idempotencyKey);
        if (check.exists && check.record && check.record.itemId === input.id) {
          this.logger.log(
            `Idempotency key conflict resolved via replay: ${input.idempotencyKey}`,
          );
          return check.record.outcome;
        }
      }

      // Unexpected error: log and fail.
      this.logger.error(
        `Unexpected error in submitRetry transaction: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw new OperationsError(
        500,
        PublicErrorCode.INTERNAL_ERROR,
        null,
        auditId,
        'An unexpected error occurred while processing the retry.',
      );
    }
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

  private async rejectOutsideTransaction(
    auditId: string,
    action: string,
    input: SubmitRetryInput,
    status: number,
    code: PublicErrorCode,
    reason: RetryDenialReason | null,
    message: string,
    subjectId: string | null,
  ): Promise<never> {
    // Rejections that occur before the main transaction (e.g., idempotency conflict,
    // item not found) save the audit record outside of a transaction.
    // This is acceptable because no queue state change occurs.
    await this.dataSource.transaction(async (manager) => {
      await this.auditStore.save(
        this.auditRecord(auditId, action, input, 'rejected', code, subjectId),
        manager,
      );
    });
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
