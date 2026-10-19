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
 * Delivery status for a notification OutboxEvent.
 *
 * State machine:
 *   PENDING → PROCESSING → DISPATCHED
 *                       └→ PENDING     (transient failure, retryCount < maxRetries)
 *   PENDING → PROCESSING → DEAD_LETTER (permanent failure / maxRetries exceeded)
 *
 * PROCESSING is a short-lived in-flight marker claimed by the poller.
 * A crashed worker leaves rows in PROCESSING; the recovery pass resets them
 * to PENDING once their processingDeadline has elapsed.
 */
export type OutboxEventStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'DISPATCHED'
  | 'DEAD_LETTER';

/**
 * OutboxEvent — canonical TypeORM entity for the notification Transactional Outbox.
 *
 * ## Purpose
 *
 * Records a side-effect (e.g. notification delivery, webhook dispatch) that
 * must be executed at least once after the owning database transaction commits.
 *
 * Callers write an OutboxEvent row **inside the same EntityManager transaction**
 * as their domain state change.  Because both writes share a single PostgreSQL
 * commit, they are atomic: either both are durable or neither is.
 *
 * ## At-least-once delivery
 *
 * The OutboxScheduler polls PENDING rows, claims them (setting status to
 * PROCESSING), dispatches them to BullMQ with the idempotency key as jobId,
 * then marks them DISPATCHED.  If a worker crashes mid-flight, the recovery
 * pass resets stale PROCESSING rows to PENDING so they are re-attempted.
 *
 * ## Idempotency
 *
 * `idempotencyKey` carries a caller-supplied deterministic hash of the event's
 * identity.  The UNIQUE constraint prevents duplicate rows for the same logical
 * event; BullMQ deduplicates at the queue layer via the same key (jobId prefix).
 *
 * ## Concurrent workers
 *
 * Workers claim batches via `FOR UPDATE SKIP LOCKED` so that two concurrent
 * pollers cannot claim the same row.  The status transition PENDING → PROCESSING
 * is the critical section; only the worker that acquires the row lock may
 * execute the delivery.
 *
 * ## Security constraints
 *
 * - Payload must contain only routing metadata (opaque IDs, channel hints,
 *   recipient IDs).  No PII, no private keys, no settlement data.
 * - Workers must never mutate canonical protocol state as a result of reading
 *   this table.
 * - DEAD_LETTER rows are never silently discarded; they remain available for
 *   operator inspection and manual replay.
 * - Optimism/EVM only — no Stellar, Soroban, or alt-chain paths.
 *
 * ## Retry auditability
 *
 * `retryCount` and `lastError` record the delivery history at row level.
 * Full stack traces must not be stored in `lastError` — capped at 1000 chars
 * so that database storage is bounded and secret values cannot leak via traces.
 */
@Entity('notification_outbox_events')
@Unique('uq_notification_outbox_idempotency_key', ['idempotencyKey'])
@Index('idx_notification_outbox_pending_scheduled', ['status', 'scheduledAt'])
@Index('idx_notification_outbox_aggregate', ['aggregateId'])
@Index('idx_notification_outbox_processing_deadline', [
  'status',
  'processingDeadline',
])
@Check('chk_notification_outbox_retry_nonneg', '"retryCount" >= 0')
@Check('chk_notification_outbox_max_retries_positive', '"maxRetries" > 0')
@Check(
  'chk_notification_outbox_retry_lte_max',
  '"retryCount" <= "maxRetries"',
)
@Check(
  'chk_notification_outbox_status_valid',
  `"status" IN ('PENDING','PROCESSING','DISPATCHED','DEAD_LETTER')`,
)
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Application event type, e.g. `NOTIFICATION:CLAIM_CREATED`,
   * `notification.send`.  Workers dispatch based on this type.
   * Unknown types are dead-lettered without execution.
   */
  @Column({ type: 'varchar', length: 128 })
  eventType: string;

  /**
   * Opaque identifier of the triggering aggregate (UUID or similar).
   * Used for routing and observability only; never for protocol decisions.
   */
  @Column({ type: 'varchar', length: 128 })
  aggregateId: string;

  /**
   * Routing-only metadata for the consumer.
   * MUST NOT contain: PII, private keys, settlement data, protocol state,
   * or any value beyond opaque IDs and routing hints.
   */
  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  /**
   * Deterministic idempotency key for this logical delivery.
   * Typically a SHA-256 digest of (eventType, aggregateId, recipientIds, channel).
   * Protected by a UNIQUE constraint; duplicates are rejected at the DB layer.
   */
  @Column({ type: 'varchar', length: 64 })
  idempotencyKey: string;

  /**
   * Current delivery status.  See OutboxEventStatus state machine above.
   *
   * Stored as varchar(16) with a CHECK constraint enforcing the four valid
   * states so that the database rejects unknown values before the application
   * can act on them (fail-closed).
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: 'PENDING',
  })
  status: OutboxEventStatus;

  /**
   * Number of delivery attempts made so far.  Starts at 0.
   */
  @Column({ type: 'int', default: 0 })
  retryCount: number;

  /**
   * Maximum delivery attempts before the row transitions to DEAD_LETTER.
   * Default 5; callers may override per event type.
   */
  @Column({ type: 'int', default: 5 })
  maxRetries: number;

  /**
   * Last error message from a failed delivery attempt.
   * Capped at 1000 characters — full stack traces must not be stored here
   * to prevent secret leakage and unbounded storage consumption.
   */
  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /**
   * BullMQ job ID assigned when the message was dispatched to the queue.
   * Null until dispatch succeeds.
   */
  @Column({ type: 'varchar', length: 256, nullable: true })
  jobId: string | null;

  /**
   * Earliest time at which a worker may pick up this row.
   * Defaults to now() so the row is immediately eligible for dispatch.
   * Set to a future Date for delayed delivery.
   */
  @Column({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  scheduledAt: Date;

  /**
   * Deadline by which the current PROCESSING claim must complete.
   * Set to now() + N seconds when a worker claims the row.
   * The recovery pass resets rows where status=PROCESSING AND
   * processingDeadline < now() back to PENDING so stale claims are cleared.
   */
  @Column({ type: 'datetime', nullable: true })
  processingDeadline: Date | null;

  /**
   * Timestamp when the message was successfully dispatched to BullMQ.
   * Null until dispatch succeeds.
   */
  @Column({ type: 'datetime', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
