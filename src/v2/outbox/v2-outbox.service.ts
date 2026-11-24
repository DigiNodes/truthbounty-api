import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { V2OutboxMessage, V2OutboxStatus } from './entities/v2-outbox-message.entity';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Provenance binding for chain-derived events.
 *
 * Binds the event to its canonical chain ID, release ID, deployment block,
 * and artifact checksum, ensuring the API cannot accept stale, ambiguous,
 * or unapproved contract states.
 */
export interface V2ChainProvenance {
  /** Positive EVM chain ID (e.g. 11155420 for OP Sepolia, 10 for OP Mainnet). */
  chainId: number;
  /** Approved release identifier (e.g. "v2.0.0-sepolia"). */
  releaseId: string;
  /** Canonical contract deployment block number on this chain. */
  deploymentBlock: string | number;
  /** SHA-256 checksum of the canonical approved contract release artifact. */
  artifactChecksum: string;
}

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
  /** Optional chain provenance binding for chain-derived events. */
  chainProvenance?: V2ChainProvenance;
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
 * sorted recipientIds, channel, and optional chainProvenance). Duplicate keys
 * within the same transaction or table raise a DB unique-violation; callers
 * should treat this as an application bug, not a retriable error.
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

  // ── Observability & Delivery Audit ─────────────────────────────────────────

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

  /**
   * Fetch all delivery history records for an aggregate, ordered chronologically.
   * Provides auditability for all side-effects triggered by a given entity.
   */
  async getDeliveryHistory(
    aggregateType: string,
    aggregateId: string,
  ): Promise<V2OutboxMessage[]> {
    return this.dataSource.getRepository(V2OutboxMessage).find({
      where: { aggregateType, aggregateId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Fetch an outbox message by its primary ID.
   */
  async getMessageById(id: string): Promise<V2OutboxMessage | null> {
    return this.dataSource.getRepository(V2OutboxMessage).findOneBy({ id });
  }

  /**
   * Fetch an outbox message by its unique idempotency key.
   */
  async getMessageByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<V2OutboxMessage | null> {
    return this.dataSource.getRepository(V2OutboxMessage).findOneBy({ idempotencyKey });
  }

  /**
   * Paginated audit query across all outbox messages.
   */
  async getDeliveryAudit(options: {
    status?: V2OutboxStatus;
    aggregateType?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ items: V2OutboxMessage[]; total: number }> {
    const { status, aggregateType, limit = 50, offset = 0 } = options;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (aggregateType) where.aggregateType = aggregateType;

    const [items, total] = await this.dataSource
      .getRepository(V2OutboxMessage)
      .findAndCount({
        where,
        order: { createdAt: 'DESC' },
        take: limit,
        skip: offset,
      });

    return { items, total };
  }

  /**
   * Operator replay action: reset a DEAD_LETTER message back to PENDING.
   *
   * @throws Error if the message is not in DEAD_LETTER status (fail-closed).
   */
  async replayDeadLetter(id: string): Promise<V2OutboxMessage> {
    const repo = this.dataSource.getRepository(V2OutboxMessage);
    const msg = await repo.findOneBy({ id });
    if (!msg) {
      throw new Error(`V2OutboxService: message ${id} not found`);
    }
    if (msg.status !== V2OutboxStatus.DEAD_LETTER) {
      throw new Error(
        `V2OutboxService: cannot replay message ${id} with status ${msg.status} (expected DEAD_LETTER)`,
      );
    }

    msg.status = V2OutboxStatus.PENDING;
    msg.retryCount = 0;
    msg.lastError = null;
    msg.processingDeadline = null;
    msg.updatedAt = new Date();

    return repo.save(msg);
  }

  // ── Idempotency key ────────────────────────────────────────────────────────

  /**
   * Build a deterministic, content-addressed idempotency key.
   *
   * Key = sha256(eventType:aggregateType:aggregateId:channel:sortedRecipients[:chainProvenance])
   *
   * Sorting recipientIds ensures key stability regardless of insertion order.
   * If chain provenance is present, binds chain ID, release ID, deployment block,
   * and artifact checksum into the key to enforce strict provenance isolation.
   */
  buildIdempotencyKey(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: V2OutboxPayload,
  ): string {
    const channel = payload.channel ?? '';
    const recipients = (payload.recipientIds ?? []).slice().sort().join(',');
    let raw = `${eventType}:${aggregateType}:${aggregateId}:${channel}:${recipients}`;

    if (payload.chainProvenance) {
      const { chainId, releaseId, deploymentBlock, artifactChecksum } =
        payload.chainProvenance;
      raw += `:${chainId}:${releaseId}:${deploymentBlock}:${artifactChecksum}`;
    }

    return createHash('sha256').update(raw).digest('hex');
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  /**
   * Validate publish params before writing to the database.
   * Throws with a clear message on the first violation (fail-closed).
   *
   * Enforces:
   * - Aggregate identifiers: non-empty, max 128 chars, valid identifier charset
   * - Event type: non-empty, max 128 chars, dotted namespace format
   * - Schedule: valid non-NaN Date, reasonable clock boundaries
   * - Retry budget: integer, 1 <= maxRetries <= 100
   * - Chain provenance (if present): valid chain ID, release ID, deployment block, and 64-hex checksum
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

    // Syntax validation for identifiers to reject control chars, injections, and invalid formats
    const validIdentifierRegex = /^[a-zA-Z0-9_-]+$/;
    if (!validIdentifierRegex.test(params.aggregateType)) {
      throw new Error('V2OutboxService: aggregateType contains invalid characters');
    }

    const validAggregateIdRegex = /^[a-zA-Z0-9_.:-]+$/;
    if (!validAggregateIdRegex.test(params.aggregateId)) {
      throw new Error('V2OutboxService: aggregateId contains invalid characters');
    }

    // Event type must be a valid dotted namespace (e.g. 'notification.send', 'webhook.fire')
    const validEventTypeRegex = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
    if (!validEventTypeRegex.test(params.eventType)) {
      throw new Error(
        'V2OutboxService: eventType format is invalid (expected namespace.action, e.g. notification.send)',
      );
    }

    // Retry budget validation: must be an integer between 1 and 100
    if (params.maxRetries !== undefined) {
      if (
        !Number.isInteger(params.maxRetries) ||
        params.maxRetries < 1 ||
        params.maxRetries > 100
      ) {
        throw new Error(
          'V2OutboxService: maxRetries must be an integer between 1 and 100',
        );
      }
    }

    // Schedule validation: must be a valid non-NaN Date with reasonable clock boundaries
    if (params.scheduledAt !== undefined) {
      if (!(params.scheduledAt instanceof Date) || isNaN(params.scheduledAt.getTime())) {
        throw new Error('V2OutboxService: scheduledAt must be a valid Date');
      }

      const nowMs = Date.now();
      const schedMs = params.scheduledAt.getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;

      if (schedMs < nowMs - thirtyDaysMs) {
        throw new Error(
          'V2OutboxService: scheduledAt cannot be more than 30 days in the past',
        );
      }
      if (schedMs > nowMs + oneYearMs) {
        throw new Error(
          'V2OutboxService: scheduledAt cannot be more than 1 year in the future',
        );
      }
    }

    // Chain provenance validation: fail closed on missing, ambiguous, or invalid chain data
    if (params.payload?.chainProvenance) {
      const cp = params.payload.chainProvenance;
      if (!Number.isInteger(cp.chainId) || cp.chainId <= 0) {
        throw new Error(
          'V2OutboxService: chainProvenance.chainId must be a positive integer',
        );
      }
      if (
        typeof cp.releaseId !== 'string' ||
        !cp.releaseId.trim() ||
        cp.releaseId.length > 64 ||
        !/^[a-zA-Z0-9_.-]+$/.test(cp.releaseId)
      ) {
        throw new Error(
          'V2OutboxService: chainProvenance.releaseId must be a valid non-empty release string',
        );
      }
      if (
        cp.deploymentBlock === undefined ||
        cp.deploymentBlock === null ||
        !/^\d+$/.test(String(cp.deploymentBlock))
      ) {
        throw new Error(
          'V2OutboxService: chainProvenance.deploymentBlock must be a non-negative block number',
        );
      }
      if (
        typeof cp.artifactChecksum !== 'string' ||
        !/^[0-9a-f]{64}$/.test(cp.artifactChecksum)
      ) {
        throw new Error(
          'V2OutboxService: chainProvenance.artifactChecksum must be a 64-character lowercase hex SHA-256 hash',
        );
      }
    }
  }
}
