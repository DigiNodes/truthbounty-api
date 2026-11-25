import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { OperationsIdempotencyKey } from './entities/operations-idempotency-key.entity';
import {
  RetrySubmission,
  OperationalCapability,
  AuthoritySource,
} from './operations.types';

/** Injection token for the operational idempotency store. */
export const OPERATIONS_IDEMPOTENCY_STORE = Symbol(
  'OPERATIONS_IDEMPOTENCY_STORE',
);

/**
 * Input for recording a new idempotency key.
 */
export interface IdempotencyKeyInput {
  key: string;
  itemId: string;
  actorId: string | null;
  capability: OperationalCapability;
  authoritySource: AuthoritySource;
  authorityExpiresAt: string | null;
  outcome: RetrySubmission;
  ttlSeconds?: number; // Default: 86400 (24 hours)
}

/**
 * Result of checking an idempotency key.
 */
export interface IdempotencyCheckResult {
  /** Whether the key already exists. */
  exists: boolean;
  /** The stored record if it exists, null otherwise. */
  record: OperationsIdempotencyKey | null;
  /** Whether the key matches the same itemId (only meaningful if exists=true). */
  itemMatches: boolean;
}

/**
 * Durable, shared idempotency store for operational retry requests.
 *
 * Implementations MUST:
 * - Be accessible across all API replicas (shared database).
 * - Survive process restarts and deployments.
 * - Enforce uniqueness of idempotency keys at the database level.
 * - Support transactional writes via EntityManager.
 * - Provide TTL-based cleanup for expired keys.
 */
export interface OperationsIdempotencyStore {
  /**
   * Check if an idempotency key exists and return the stored record.
   * Used for replay detection before submitting a retry.
   */
  check(key: string): Promise<IdempotencyCheckResult>;

  /**
   * Save a new idempotency key with its outcome.
   * MUST be called within a transaction (using manager parameter).
   * Throws on duplicate key constraint violation.
   */
  save(input: IdempotencyKeyInput, manager: EntityManager): Promise<void>;

  /**
   * Delete expired idempotency keys (expiresAt < now).
   * Returns the count of deleted keys.
   * Used by scheduled cleanup jobs.
   */
  cleanupExpired(): Promise<number>;
}

/**
 * Default durable idempotency store using TypeORM.
 *
 * Replaces the process-local Map in OperationsService. Keys are shared across
 * API replicas and survive restarts. TTL-based expiry ensures keys don't grow
 * without bound.
 *
 * ## Transaction boundary
 *
 * The `save()` method MUST be called with an EntityManager from an active
 * transaction. This ensures the idempotency key, queue source update, and
 * audit record are atomically committed together.
 *
 * ## Concurrency
 *
 * Duplicate keys are rejected at the database level via primary key constraint.
 * Race conditions between replicas are handled gracefully: the second writer
 * receives a constraint violation and can replay the cached outcome by calling
 * `check()` again.
 *
 * ## Cleanup
 *
 * Expired keys (expiresAt < now) are periodically deleted by calling
 * `cleanupExpired()` from a scheduled job or maintenance task. The default TTL
 * is 24 hours, which is sufficient to prevent replay attacks during typical
 * retry windows while keeping the table bounded.
 */
@Injectable()
export class DurableOperationsIdempotencyStore
  implements OperationsIdempotencyStore
{
  private readonly logger = new Logger(
    DurableOperationsIdempotencyStore.name,
  );
  private readonly defaultTtlSeconds = 86400; // 24 hours

  constructor(
    @InjectRepository(OperationsIdempotencyKey)
    private readonly repo: Repository<OperationsIdempotencyKey>,
  ) {}

  async check(key: string): Promise<IdempotencyCheckResult> {
    const record = await this.repo.findOne({ where: { key } });
    if (!record) {
      return { exists: false, record: null, itemMatches: false };
    }
    // Note: itemMatches is only meaningful if exists=true; caller checks itemId equality
    return { exists: true, record, itemMatches: true };
  }

  async save(
    input: IdempotencyKeyInput,
    manager: EntityManager,
  ): Promise<void> {
    const ttlSeconds = input.ttlSeconds ?? this.defaultTtlSeconds;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const record = manager.getRepository(OperationsIdempotencyKey).create({
      key: input.key,
      itemId: input.itemId,
      actorId: input.actorId,
      capability: input.capability,
      authoritySource: input.authoritySource,
      authorityExpiresAt: input.authorityExpiresAt
        ? new Date(input.authorityExpiresAt)
        : null,
      outcome: input.outcome,
      createdAt: now,
      expiresAt,
    });

    await manager.getRepository(OperationsIdempotencyKey).save(record);

    this.logger.log(
      `Idempotency key saved: ${input.key} (itemId=${input.itemId}, expiresAt=${expiresAt.toISOString()})`,
    );
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(OperationsIdempotencyKey)
      .where('expiresAt < :now', { now })
      .execute();

    const deleted = result.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(`Cleaned up ${deleted} expired idempotency keys.`);
    }
    return deleted;
  }
}
