import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

/**
 * Delivery status of a V2OutboxMessage.
 *
 * State machine:
 *   PENDING → PROCESSING → DISPATCHED
 *                       └→ PENDING  (on transient failure, retryCount < maxRetries)
 *   PENDING → PROCESSING → DEAD_LETTER (on permanent failure / maxRetries exceeded)
 *
 * PROCESSING is a short-lived in-flight marker claimed via FOR UPDATE SKIP LOCKED.
 * A crashed worker leaves rows in PROCESSING; the recovery query resets them to
 * PENDING once processingDeadline has elapsed.
 */
export enum V2OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  DEAD_LETTER = 'DEAD_LETTER',
}

/**
 * V2OutboxMessage — the durable record of a side-effect that must be delivered
 * at least once after a state-changing database transaction commits.
 *
 * ## Transactional Outbox invariant
 *
 * A caller writes a V2OutboxMessage row **inside the same EntityManager
 * transaction** as the state change that requires the delivery.  Because both
 * writes share a single commit, either both are durable or neither is:
 *
 * - If the transaction commits, the outbox row is visible to the worker and
 *   delivery is guaranteed (at-least-once).
 * - If the transaction rolls back, the outbox row is also rolled back and no
 *   spurious delivery is attempted.
 *
 * ## Idempotency
 *
 * `idempotencyKey` carries a caller-supplied deterministic key (e.g.
 * sha256(eventType + aggregateType + aggregateId + ...)).  The UNIQUE
 * constraint on this column prevents duplicate rows for the same logical event;
 * callers that publish the same key twice within a transaction receive a
 * conflict error and must decide whether to treat it as a no-op or an
 * application bug.  The BullMQ `jobId` is set to `outbox-<idempotencyKey>` so
 * duplicate dispatches at the queue layer are also deduplicated.
 *
 * ## Fail-closed guarantees
 *
 * - Payload may contain only routing metadata (IDs, event names, opaque
 *   references).  No PII, no protocol state, no settlement data.
 * - Workers must never mutate canonical protocol state (CanonicalEvent,
 *   evidence, verification, dispute rows) as a result of reading this table.
 * - DEAD_LETTER rows are never silently discarded; they remain visible for
 *   operator inspection and manual replay.
 *
 * ## Security constraints
 *
 * - Optimism/EVM only.  No Stellar, Soroban, Freighter, or alt-chain paths.
 * - Do not store private keys, live credentials, or production mocks in payload.
 * - eventType must be a known application event; unknown types are dead-lettered
 *   by the worker, not executed as opaque code.
 */
@Entity('v2_outbox_messages')
@Unique('uq_v2_outbox_idempotency_key', ['idempotencyKey'])
@Index('idx_v2_outbox_pending_scheduled', ['status', 'scheduledAt'])
@Index('idx_v2_outbox_aggregate', ['aggregateType', 'aggregateId'])
@Index('idx_v2_outbox_processing_deadline', ['status', 'processingDeadline'])
@Check('chk_v2_outbox_retry_nonneg', '"retryCount" >= 0')
@Check('chk_v2_outbox_max_retries_positive', '"maxRetries" > 0')
@Check(
  'chk_v2_outbox_retry_lte_max',
  '"retryCount" <= "maxRetries"',
)
@Check(
  'chk_v2_outbox_status_valid',
  `"status" IN ('PENDING','PROCESSING','DISPATCHED','DEAD_LETTER')`,
)
export class V2OutboxMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Domain aggregate type that triggered this delivery, e.g. 'claim', 'evidence',
   * 'verification_round'. Used for routing and observability, never for protocol logic.
   */
  @Column({ type: 'varchar', length: 128 })
  aggregateType: string;

  /**
   * Opaque identifier of the specific aggregate instance (UUID or hex ID).
   */
  @Column({ type: 'varchar', length: 128 })
  aggregateId: string;

  /**
   * Application event type, e.g. 'notification.send', 'webhook.fire',
   * 'realtime.broadcast'. The worker dispatches based on this type.
   * Unknown types are dead-lettered without execution.
   */
  @Column({ type: 'varchar', length: 128 })
  eventType: string;

  /**
   * Routing-only metadata for the consumer.
   * MUST NOT contain: PII, private keys, settlement data, protocol state,
   * canonical event details beyond opaque IDs.
   */
  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  /**
   * Deterministic idempotency key for this logical delivery, derived by the
   * caller as sha256(eventType + aggregateType + aggregateId + ...).
   * Protected by a UNIQUE constraint; duplicate keys are rejected at the DB layer.
   */
  @Column({ type: 'varchar', length: 64 })
  idempotencyKey: string;

  /**
   * Current delivery status. See V2OutboxStatus state machine above.
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: V2OutboxStatus.PENDING,
  })
  status: V2OutboxStatus;

  /**
   * Number of delivery attempts made so far.
   */
  @Column({ type: 'int', default: 0 })
  retryCount: number;

  /**
   * Maximum delivery attempts before transitioning to DEAD_LETTER.
   * Default 5 matches the BullMQ queue's own retry setting so both
   * layers agree on when a delivery is permanently failed.
   */
  @Column({ type: 'int', default: 5 })
  maxRetries: number;

  /**
   * Last error message recorded during a failed delivery attempt.
   * Capped at 1000 characters; full stack traces must not be stored here.
   */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /**
   * BullMQ job ID assigned when the message was successfully dispatched to
   * the queue.  Null until dispatch succeeds.
   */
  @Column({ type: 'varchar', length: 256, nullable: true })
  jobId: string | null;

  /**
   * Earliest time at which the worker may pick up this message.
   * Set to now() on creation; can be set to a future time for delayed delivery.
   * The polling query always filters `scheduledAt <= now()`.
   */
  @Column({ type: Date, default: () => 'CURRENT_TIMESTAMP' })
  scheduledAt: Date;

  /**
   * Deadline by which the current PROCESSING claim must complete.
   * Set to now() + N seconds when a worker claims the row.
   * Recovery re-sets rows where status=PROCESSING AND processingDeadline < now()
   * back to PENDING, so crashed workers do not leave messages stuck forever.
   */
  @Column({ type: Date, nullable: true })
  processingDeadline: Date | null;

  /**
   * Timestamp when the message was successfully dispatched to BullMQ.
   */
  @Column({ type: Date, nullable: true })
  processedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
