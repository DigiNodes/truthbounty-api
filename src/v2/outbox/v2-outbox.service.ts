import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { V2OutboxMessage, V2OutboxStatus } from './entities/v2-outbox-message.entity';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Routing-only metadata carried in an outbox message payload.
 *
 * Security contract: this object MUST NOT contain private keys, user PII,
 * settlement data, governance state, canonical event details beyond opaque
 * IDs, or any value that could be interpreted as protocol-authoritative.
 * The outbox is a delivery mechanism, not a state store.
 */
export interface V2OutboxPayload {
  /** Opaque notification or aggregate reference ID. */
  referenceId?: string;
  /** Delivery channel hint, e.g. "webhook", "in_app", "realtime". */
  channel?: string;
  /** Opaque recipient identifiers — never PII or wallet private keys. */
  recipientIds?: string[];
  /** Queue name override; defaults to the worker's configured queue. */
  targetQueue?: string;
  /** Non-sensitive routing context for the consumer. */
  meta?: Record<string, string | number | boolean>;
}

/**
 * Parameters for creating a single outbox message within a transaction.
 */
export interface V2OutboxPublishParams {
  /**
   * Domain aggregate type, e.g. 'claim', 'evidence', 'verification_round'.
   * Used for routing and metrics only; never used for protocol decisions.
   */
  aggregateType: string;
  /**
   * Opaque aggregate identifier (UUID, hex ID, etc.).
   */
  aggregateId: string;
  /**
   * Application event type, e.g. 'notification.send', 'webhook.fire'.
   * Workers dispatch based on this value. Unknown types are dead-lettered.
   */
  eventType: string;
  /**
   * Routing-only metadata. See V2OutboxPayload security contract.
   */
  payload: V2OutboxPayload;
  /**
   * Maximum delivery attempts. Defaults to 5.
   * On exceeding this limit the message transitions to DEAD_LETTER.
   */
  maxRetries?: number;
  /**
   * Earliest delivery time. Defaults to now.
   * Set to a future Date for delayed delivery.
   */
  scheduledAt?: Date;
}

/**
 * Result returned by a successful publishWithManager call.
 */
export interface V2OutboxPublishResult {
  /** Persisted row id (UUID). */
  id: string;
  /** Idempotency key derived from the message content. */
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * V2OutboxService — write side of the TypeORM Transactional Outbox (V2-BE-113).
 *
 * ## Usage
 *
 * Call {@link publishWithManager} **inside an existing TypeORM transaction**:
 *
 * ```ts
 * await this.txRunner.run(async (manager) => {
 *   // 1. Your domain state change
 *   await manager.getRepository(SomeDomainEntity).save(entity);
 *
 *   // 2. Atomically record the delivery work
 *   await this.v2OutboxService.publishWithManager(manager, {
 *     aggregateType: 'claim',
 *     aggregateId: claim.id,
 *     eventType: 'notification.send',
 *     payload: { channel: 'in_app', recipientIds: [userId] },
 *   });
 * });
 * ```
 *
 * If the outer transaction commits, the outbox row is durable and the worker
 * will deliver it.  If the transaction rolls back, the outbox row is also
 * rolled back and no delivery is attempted — atomicity is guaranteed at the
 * database level, not by application-level compensation.
 *
 * ## Idempotency
 *
 * The idempotency key is a sha256 of (eventType, aggregateType, aggregateId,
 * sorted recipientIds, channel).  Duplicate keys within the same transaction
 * raise a DB unique-violation; callers should treat this as an application
 * bug, not a retriable error.
 *
 * ## Security invariants
 *
 * - Payload must not carry PII, private keys, settlement values, or any data
 *   that would make the API authoritative over protocol state.
 * - Optimism/EVM only; no Stellar, Soroban, or alt-chain paths.
 * - Fail-closed: if any validation fails, throw rather than writing a row.
 */
@Injectable()
export class V2OutboxService {
  private readonly logger = new Logger(V2OutboxService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ── Write side ─────────────────────────────────────────────────────────────

  /**
   * Write a V2OutboxMessage row inside the caller's active EntityManager
   * transaction.  The row is only durable if the caller's transaction commits.
   *
   * @throws Error if params fail validation (fail-closed — do not retry).
   * @throws QueryFailedError if the idempotency key already exists in this tx.
   */
  async publishWithManager(
    manager: EntityManager,
    params: V2OutboxPublishParams,
  ): Promise<V2OutboxPublishResult> {
    this.validateParams(params);

    const idempotencyKey = this.buildIdempotencyKey(
      params.eventType,
      params.aggregateType,
      params.aggregateId,
      params.payload,
    );

    const repo = manager.getRepository(V2OutboxMessage);

    const msg = repo.create({
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      eventType: params.eventType,
      payload: params.payload as Record<string, unknown>,
      idempotencyKey,
      status: V2OutboxStatus.PENDING,
      retryCount: 0,
      maxRetries: params.maxRetries ?? 5,
      lastError: null,
      jobId: null,
      scheduledAt: params.scheduledAt ?? new Date(),
      processingDeadline: null,
      processedAt: null,
    });

    const saved = await repo.save(msg);

    this.logger.debug(
      `V2OutboxMessage published: id=${saved.id} type=${params.eventType} ` +
        `aggregate=${params.aggregateType}:${params.aggregateId}`,
    );

    return { id: saved.id, idempotencyKey };
  }

  // ── Observability ──────────────────────────────────────────────────────────

  /** Returns the count of PENDING messages. Used by health checks. */
  async getPendingCount(): Promise<number> {
    return this.dataSource.getRepository(V2OutboxMessage).countBy({
      status: V2OutboxStatus.PENDING,
    });
  }

  /** Returns the count of DEAD_LETTER messages. Used for alerting. */
  async getDeadLetterCount(): Promise<number> {
    return this.dataSource.getRepository(V2OutboxMessage).countBy({
      status: V2OutboxStatus.DEAD_LETTER,
    });
  }

  // ── Idempotency key ────────────────────────────────────────────────────────

  /**
   * Build a deterministic, content-addressed idempotency key.
   *
   * Key = sha256(eventType:aggregateType:aggregateId:channel:sortedRecipients)
   *
   * Sorting recipientIds ensures key stability regardless of insertion order.
   * This is a pure function and is exposed for testing.
   */
  buildIdempotencyKey(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: V2OutboxPayload,
  ): string {
    const channel = payload.channel ?? '';
    const recipients = (payload.recipientIds ?? []).slice().sort().join(',');
    const raw = `${eventType}:${aggregateType}:${aggregateId}:${channel}:${recipients}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  /**
   * Validate publish params before writing to the database.
   * Throws with a clear message on the first violation (fail-closed).
   *
   * Validation is intentionally minimal — just enough to prevent clearly
   * invalid rows from reaching the DB and confusing the worker.
   */
  private validateParams(params: V2OutboxPublishParams): void {
    if (!params.aggregateType?.trim()) {
      throw new Error('V2OutboxService: aggregateType must not be empty');
    }
    if (!params.aggregateId?.trim()) {
      throw new Error('V2OutboxService: aggregateId must not be empty');
    }
    if (!params.eventType?.trim()) {
      throw new Error('V2OutboxService: eventType must not be empty');
    }
    if (params.aggregateType.length > 128) {
      throw new Error('V2OutboxService: aggregateType exceeds 128 characters');
    }
    if (params.aggregateId.length > 128) {
      throw new Error('V2OutboxService: aggregateId exceeds 128 characters');
    }
    if (params.eventType.length > 128) {
      throw new Error('V2OutboxService: eventType exceeds 128 characters');
    }
    if (params.maxRetries !== undefined && params.maxRetries < 1) {
      throw new Error('V2OutboxService: maxRetries must be >= 1');
    }
    if (params.scheduledAt !== undefined && !(params.scheduledAt instanceof Date)) {
      throw new Error('V2OutboxService: scheduledAt must be a Date');
    }
  }
}
