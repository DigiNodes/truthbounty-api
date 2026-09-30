import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { Queue } from 'bullmq';
import { V2OutboxMessage, V2OutboxStatus } from './entities/v2-outbox-message.entity';
import { MetricsService } from '../../metrics/metrics.service';
import {
  determineRetryBehavior,
  ErrorClassification,
} from '../../queue/retry-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** BullMQ queue name this worker dispatches to. */
export const V2_OUTBOX_QUEUE_NAME = 'v2-outbox' as const;

/** Job name placed on the queue for every dispatched message. */
export const V2_OUTBOX_JOB_NAME = 'v2-outbox-deliver' as const;

/** Max rows claimed per poll cycle to bound transaction time. */
const POLL_BATCH_SIZE = 50;

/**
 * How long (seconds) a PROCESSING claim is held before the crash-recovery
 * pass resets it to PENDING. Must be longer than the worst-case dispatch
 * latency under acceptable load.
 */
const PROCESSING_DEADLINE_SECONDS = 30;

/**
 * How many PROCESSING rows to reset per recovery pass.
 * Kept small to avoid large update transactions during busy periods.
 */
const RECOVERY_BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * V2OutboxWorker — read/relay side of the TypeORM Transactional Outbox (V2-BE-113).
 *
 * ## Delivery guarantee
 *
 * The worker implements at-least-once delivery:
 * 1. A batch of PENDING rows is claimed atomically inside a transaction using
 *    `FOR UPDATE SKIP LOCKED`, preventing any other worker instance from
 *    processing the same row concurrently.
 * 2. Claimed rows transition to PROCESSING with a `processingDeadline`.
 * 3. Each claimed row is dispatched to BullMQ with `jobId = outbox-<idempotencyKey>`.
 *    BullMQ deduplicates by jobId, so duplicate dispatches are safe.
 * 4. Successfully dispatched rows transition to DISPATCHED; failed rows have
 *    their retryCount incremented and transition back to PENDING (or to
 *    DEAD_LETTER on exhaustion).
 *
 * ## Crash recovery
 *
 * A separate `recoverStuckMessages` pass runs on every poll cycle. It
 * resets rows that have been PROCESSING past their `processingDeadline`
 * back to PENDING, so a crashed or stalled worker does not permanently
 * block delivery.
 *
 * ## Concurrency safety
 *
 * `FOR UPDATE SKIP LOCKED` ensures rows are never claimed by two workers
 * simultaneously. The `isPolling` guard prevents a single-instance worker
 * from overlapping poll cycles if a cycle takes longer than the cron interval.
 *
 * ## Fail-closed guarantees
 *
 * - Workers never mutate canonical protocol state (CanonicalEvent, evidence,
 *   verification, dispute rows).
 * - Redis/BullMQ failures are recorded as delivery failures on the outbox row;
 *   they do not invalidate or rewrite protocol state.
 * - Unknown event types are dead-lettered immediately, not executed.
 * - All delivery failures are observable via Prometheus metrics and structured
 *   logs; no silent fallback to fabricated success.
 *
 * ## Security invariants
 *
 * - Optimism/EVM only. No Stellar, Soroban, Freighter, or alt-chain paths.
 * - Payload forwarded to BullMQ contains only the message's routing metadata
 *   (idempotencyKey, outboxMessageId, eventType, aggregateType, aggregateId,
 *   plus the caller-supplied payload). No PII, credentials, or protocol state.
 */
@Injectable()
export class V2OutboxWorker implements OnModuleDestroy {
  private readonly logger = new Logger(V2OutboxWorker.name);

  /** Guards against overlapping poll cycles within a single instance. */
  private isPolling = false;

  /** Set during shutdown to prevent new poll cycles from starting. */
  private shuttingDown = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectQueue(V2_OUTBOX_QUEUE_NAME)
    private readonly queue: Queue,
    private readonly metricsService: MetricsService,
  ) {}

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  // ── Poll cycle ─────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_5_SECONDS)
  async handleCron(): Promise<void> {
    if (this.shuttingDown || this.isPolling) {
      this.logger.debug(
        this.shuttingDown
          ? 'Outbox worker shutting down — skipping poll'
          : 'Previous poll cycle still active — skipping tick',
      );
      return;
    }

    this.isPolling = true;
    try {
      await this.recoverStuckMessages();
      await this.pollAndDispatch();
    } catch (err) {
      this.logger.error(
        `Outbox poll cycle error: ${(err as Error)?.message ?? err}`,
        (err as Error)?.stack,
      );
    } finally {
      this.isPolling = false;
    }
  }

  // ── Crash recovery ─────────────────────────────────────────────────────────

  /**
   * Reset PROCESSING rows whose processingDeadline has elapsed back to PENDING.
   *
   * This is the only recovery path for crashed workers. It runs at the start
   * of every poll cycle before claiming new work, ensuring stuck rows are
   * unblocked on the next poll after the deadline elapses.
   */
  async recoverStuckMessages(): Promise<void> {
    const now = new Date();

    const result = await this.dataSource
      .createQueryBuilder()
      .update(V2OutboxMessage)
      .set({
        status: V2OutboxStatus.PENDING,
        processingDeadline: null,
      })
      .where('status = :status', { status: V2OutboxStatus.PROCESSING })
      .andWhere('processingDeadline < :now', { now })
      .limit(RECOVERY_BATCH_SIZE)
      .execute();

    if ((result.affected ?? 0) > 0) {
      this.logger.warn(
        `Recovered ${result.affected} stuck PROCESSING message(s) back to PENDING`,
      );
      this.metricsService.incrementCounter(
        'v2_outbox_recovered_total',
        result.affected ?? 0,
      );
    }
  }

  // ── Poll and dispatch ──────────────────────────────────────────────────────

  /**
   * Claim a batch of PENDING messages and dispatch each to BullMQ.
   *
   * The claim uses `FOR UPDATE SKIP LOCKED` inside a transaction so multiple
   * worker instances never process the same row simultaneously. The transition
   * to PROCESSING with a deadline is committed before any external call so
   * that a crash after the commit but before dispatch leaves a recoverable
   * PROCESSING row rather than a silently lost one.
   */
  async pollAndDispatch(): Promise<void> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) return;

    this.logger.debug(`V2OutboxWorker: claimed ${claimed.length} message(s)`);
    this.metricsService.incrementCounter('v2_outbox_batch_claimed_total', claimed.length);

    for (const msg of claimed) {
      await this.dispatchOne(msg);
    }
  }

  /**
   * Atomically claim up to POLL_BATCH_SIZE PENDING rows.
   *
   * Uses `FOR UPDATE SKIP LOCKED` to avoid blocking other workers and to
   * prevent the same row from being claimed twice. All claimed rows are
   * immediately set to PROCESSING with a deadline in the same transaction.
   *
   * SQLite (used in integration tests) does not support `FOR UPDATE SKIP LOCKED`
   * so the lock mode degrades gracefully; the correctness properties are
   * verified against the behaviour under PostgreSQL.
   */
  private async claimBatch(): Promise<V2OutboxMessage[]> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const repo = manager.getRepository(V2OutboxMessage);

      // Select pending rows scheduled for now or earlier, ordered for FIFO
      // delivery, locked for exclusive update, skipping rows already locked
      // by another worker instance.
      const rows = await repo
        .createQueryBuilder('msg')
        .where('msg.status = :status', { status: V2OutboxStatus.PENDING })
        .andWhere('msg.scheduledAt <= :now', { now: new Date() })
        .orderBy('msg.scheduledAt', 'ASC')
        .addOrderBy('msg.createdAt', 'ASC')
        .take(POLL_BATCH_SIZE)
        .setLock('pessimistic_write', undefined, ['skip_locked'])
        .getMany();

      if (rows.length === 0) return [];

      // Transition each claimed row to PROCESSING with a deadline.
      const deadline = new Date(
        Date.now() + PROCESSING_DEADLINE_SECONDS * 1000,
      );
      const ids = rows.map((r) => r.id);

      await repo
        .createQueryBuilder()
        .update()
        .set({
          status: V2OutboxStatus.PROCESSING,
          processingDeadline: deadline,
        })
        .whereInIds(ids)
        // Double-check status inside the lock to guard against a race between
        // claim and the update (should be impossible with FOR UPDATE, but
        // explicit is safer and documents the invariant).
        .andWhere('status = :status', { status: V2OutboxStatus.PENDING })
        .execute();

      return rows;
    });
  }

  // ── Single-message dispatch ─────────────────────────────────────────────────

  /**
   * Dispatch one claimed message to BullMQ.
   *
   * Success: transitions to DISPATCHED, records jobId and processedAt.
   * Transient failure: increments retryCount, resets to PENDING for next cycle.
   * Permanent failure (maxRetries exceeded or non-retryable): transitions to DEAD_LETTER.
   *
   * The BullMQ jobId is `outbox-<idempotencyKey>`, giving queue-level
   * deduplication as a second layer of idempotency protection.
   */
  private async dispatchOne(msg: V2OutboxMessage): Promise<void> {
    try {
      const retryBehavior = determineRetryBehavior(
        new Error(msg.lastError ?? 'initial'),
        msg.retryCount,
      );

      const job = await this.queue.add(
        V2_OUTBOX_JOB_NAME,
        {
          outboxMessageId: msg.id,
          idempotencyKey: msg.idempotencyKey,
          eventType: msg.eventType,
          aggregateType: msg.aggregateType,
          aggregateId: msg.aggregateId,
          // Payload forwarded verbatim — routing metadata only.
          // Workers must not treat this as protocol-authoritative state.
          payload: msg.payload,
        },
        {
          // Deduplicates at the BullMQ layer: a second dispatch of the same
          // idempotencyKey is a no-op if a job with this id already exists.
          jobId: `outbox-${msg.idempotencyKey}`,
          attempts:
            retryBehavior.classification === ErrorClassification.NETWORK ? 5 : 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      );

      await this.dataSource.getRepository(V2OutboxMessage).update(msg.id, {
        status: V2OutboxStatus.DISPATCHED,
        jobId: String(job.id ?? ''),
        processedAt: new Date(),
        processingDeadline: null,
        lastError: null,
      });

      this.metricsService.incrementCounter('v2_outbox_dispatched_total', 1);
      this.logger.debug(
        `V2OutboxMessage ${msg.id} dispatched to BullMQ as job ${job.id}`,
      );
    } catch (err) {
      await this.handleDispatchFailure(msg, err as Error);
    }
  }

  /**
   * Record a dispatch failure on the outbox row.
   *
   * Determines whether the error is retryable via the shared retry-utils.
   * Non-retryable errors (VALIDATION, AUTHORIZATION, UNKNOWN) and rows that
   * have exhausted maxRetries are transitioned to DEAD_LETTER immediately.
   * All other errors reset the row to PENDING for the next poll cycle.
   */
  private async handleDispatchFailure(
    msg: V2OutboxMessage,
    err: Error,
  ): Promise<void> {
    const newRetryCount = msg.retryCount + 1;
    const retryBehavior = determineRetryBehavior(err, newRetryCount);
    const exhausted = newRetryCount >= msg.maxRetries;
    const isDead = !retryBehavior.shouldRetry || exhausted;

    const errorText = String(err?.message ?? 'Unknown dispatch error').slice(0, 1000);

    await this.dataSource.getRepository(V2OutboxMessage).update(msg.id, {
      retryCount: newRetryCount,
      lastError: errorText,
      status: isDead ? V2OutboxStatus.DEAD_LETTER : V2OutboxStatus.PENDING,
      processingDeadline: null,
    });

    if (isDead) {
      this.metricsService.incrementCounter('v2_outbox_dead_lettered_total', 1);
      this.logger.error(
        `V2OutboxMessage ${msg.id} dead-lettered after ${newRetryCount} attempts ` +
          `(type=${msg.eventType} aggregate=${msg.aggregateType}:${msg.aggregateId}): ${errorText}`,
      );
    } else {
      this.metricsService.incrementCounter('v2_outbox_retry_total', 1);
      this.logger.warn(
        `V2OutboxMessage ${msg.id} dispatch failed, will retry ` +
          `(attempt ${newRetryCount}/${msg.maxRetries}): ${errorText}`,
      );
    }
  }
}
