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
 * Delivery status state machine:
 *
 *   PENDING → DISPATCHED  (scheduler enqueued job and updated DB)
 *   PENDING → DEAD_LETTER (all retries exhausted or terminal error)
 *   DISPATCHED → PROCESSING (processor picks up the job from BullMQ)
 *   PROCESSING → DISPATCHED (processor completed successfully)
 *   PROCESSING → PENDING (transient error, retryCount < maxRetries)
 *   PROCESSING → DEAD_LETTER (terminal error or budget exhausted)
 */
export type OutboxEventStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'DISPATCHED'
  | 'DEAD_LETTER';

/**
 * OutboxEvent — durable record of a notification side-effect that must be
 * delivered at-least-once after the state-changing transaction that created it.
 *
 * ## Transactional outbox invariant
 * The row must be written inside the same EntityManager transaction as the
 * domain state change. Either both commit or both roll back; spurious
 * deliveries are impossible if callers honour this contract.
 *
 * ## Idempotency
 * `idempotencyKey` is a deterministic sha256 derived from (eventType,
 * aggregateId, sorted recipientIds). The UNIQUE constraint prevents duplicate
 * rows. The scheduler sets `jobId = 'outbox-<idempotencyKey>'` so BullMQ
 * deduplicates re-enqueues across concurrent or replayed scheduler runs.
 *
 * ## Security / payload constraints
 * `payload` MUST carry only routing metadata (opaque IDs, event names).
 * No PII, settlement data, private keys, or canonical protocol state.
 *
 * ## jobId accuracy guarantee (PREWAVE-BE-200)
 * Each row stores the BullMQ job ID that was returned for *that specific row*.
 * The scheduler updates rows individually (or via per-event update) so that a
 * failure in one enqueue never corrupts the recorded job ID of a sibling row.
 */
@Entity('outbox_events')
@Unique('uq_outbox_idempotency_key', ['idempotencyKey'])
@Index('idx_outbox_status_created', ['status', 'createdAt'])
@Index('idx_outbox_aggregate', ['aggregateId'])
@Check('chk_outbox_retry_nonneg', '"retryCount" >= 0')
@Check('chk_outbox_max_retries_positive', '"maxRetries" > 0')
@Check('chk_outbox_retry_lte_max', '"retryCount" <= "maxRetries"')
@Check(
  'chk_outbox_status_valid',
  `"status" IN ('PENDING','PROCESSING','DISPATCHED','DEAD_LETTER')`,
)
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Namespaced event type, e.g. "NOTIFICATION:CLAIM_CREATED".
   * Unknown types are dead-lettered by the processor without execution.
   */
  @Column({ type: 'varchar', length: 128 })
  eventType: string;

  /**
   * Opaque identifier of the aggregate that triggered this event (UUID or hex).
   */
  @Column({ type: 'varchar', length: 128 })
  aggregateId: string;

  /**
   * Routing-only metadata for the consumer.
   * MUST NOT contain PII, protocol state, settlement data, or private keys.
   */
  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  /**
   * Deterministic idempotency key — sha256(eventType, aggregateId, sorted recipientIds).
   * Protected by a UNIQUE constraint; callers that publish the same key twice
   * within a transaction receive a conflict and must treat it as a no-op.
   */
  @Column({ type: 'varchar', length: 64 })
  idempotencyKey: string;

  /** Current delivery status. See state machine above. */
  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status: OutboxEventStatus;

  /** Number of delivery attempts made so far. */
  @Column({ type: 'int', default: 0 })
  retryCount: number;

  /**
   * Maximum delivery attempts before transitioning to DEAD_LETTER.
   * Must agree with the BullMQ queue's own `attempts` setting.
   */
  @Column({ type: 'int', default: 5 })
  maxRetries: number;

  /**
   * Last error message recorded during a failed delivery attempt.
   * Capped at 1 000 characters; full stack traces must not be stored here.
   */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  /**
   * BullMQ job ID assigned when this specific row was successfully enqueued.
   * Null until the scheduler confirms the enqueue for *this* event.
   * Set to `outbox-<idempotencyKey>` to enable idempotent re-enqueue.
   */
  @Column({ type: 'varchar', length: 256, nullable: true })
  jobId: string | null;

  /**
   * Timestamp when the row transitioned to DISPATCHED or DEAD_LETTER.
   * Null while the row is still PENDING or PROCESSING.
   */
  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
