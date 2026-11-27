import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationProcessorJob } from './notification-processor.service';
import { GracefulShutdownService } from '../../common/lifecycle/graceful-shutdown.service';

/** Routing payload encoded in outbox_events.payload (JSON string). */
interface OutboxPayload {
  recipientIds?: string[];
  [key: string]: unknown;
}

/** Shape of a row returned by Prisma's outboxEvent.findMany. */
interface OutboxRow {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: string;
  idempotencyKey: string;
  status: string;
  retryCount: number;
  maxRetries: number;
}

/**
 * OutboxScheduler
 *
 * Scheduled job that polls the outbox table for PENDING notification events
 * and enqueues them in BullMQ. Implements the transactional outbox pattern
 * for guaranteed at-least-once delivery.
 *
 * ## Correctness guarantee (PREWAVE-BE-200)
 *
 * Each outbox row is updated with the job ID returned specifically for that row.
 * The scheduler maintains an explicit Map<eventId, jobId> and updates rows
 * one-by-one so that:
 *
 * - A failure on event N never contaminates the recorded jobId of event M.
 * - No event is marked DISPATCHED unless its own BullMQ job was confirmed.
 * - If the process crashes between enqueue and DB update the row stays PENDING.
 *   On the next run the same `outbox-<idempotencyKey>` jobId is passed to
 *   BullMQ, which silently deduplicates the re-enqueue.
 *
 * ## Concurrency
 *
 * The `isPolling` guard prevents a second run on the same instance from
 * overlapping. Concurrent instances on separate pods may race to enqueue the
 * same row; BullMQ deduplication via the stable jobId makes duplicate enqueues
 * safe. The DB update uses a `WHERE status = 'PENDING'` predicate so a
 * concurrent pod that already updated the row will simply find `affected = 0`.
 *
 * Flow per batch:
 *   1. Query PENDING events (batch)
 *   2. For each event: enqueue → record (eventId, jobId) pair on success
 *   3. For each successful pair: UPDATE row WHERE id = ? AND status = 'PENDING'
 *      SET status = 'DISPATCHED', jobId = <that event's jobId>
 *   4. Any event whose enqueue failed remains PENDING for the next run.
 *
 * Runs every 5 seconds via @Cron.
 * Batch size: 50 events per poll.
 */
@Injectable()
export class OutboxScheduler {
  private readonly logger = new Logger(OutboxScheduler.name);

  private readonly BATCH_SIZE = 50;

  /**
   * Re-entrant guard: prevents a slow poll from overlapping with the next tick
   * on the same pod. Concurrent pods are handled by BullMQ idempotency.
   */
  private isPolling = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications')
    private readonly notificationQueue: Queue,
    private readonly gracefulShutdown: GracefulShutdownService,
  ) {}

  /**
   * Poll outbox for PENDING events every 5 seconds.
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async pollOutbox(): Promise<void> {
    if (this.gracefulShutdown.isDraining) return;
    if (this.isPolling) {
      this.logger.debug(
        'Previous outbox polling run still active, skipping tick',
      );
      return;
    }

    this.isPolling = true;
    try {
      await this.gracefulShutdown.runTracked(
        'notification-outbox-scheduler',
        () => this.runPollCycle(),
      );
    } catch (error) {
      if (this.gracefulShutdown.isDraining) return;
      this.logger.error(`Outbox polling failed: ${error.message}`, error.stack);
      // Continue polling on next interval despite errors
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * One poll cycle: enqueue each PENDING event, then persist the confirmed
   * job ID back to the exact row that produced it.
   *
   * Partial failures are tolerated: events whose enqueue succeeded are marked
   * DISPATCHED with their own jobId; events whose enqueue failed remain PENDING
   * and are retried on the next poll cycle.
   */
  private async runPollCycle(): Promise<void> {
    const pendingEvents = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: this.BATCH_SIZE,
    });

    if (pendingEvents.length === 0) {
      return;
    }

    this.logger.debug(
      `Found ${pendingEvents.length} pending notification events`,
    );

    // Build an explicit eventId → jobId map so each row gets its own confirmed
    // job ID. Enqueue failures are logged but do not stop sibling events.
    const dispatched = new Map<string, string>(); // eventId → jobId

    for (const event of pendingEvents) {
      try {
        const jobId = await this.enqueueEvent(event as OutboxRow);
        dispatched.set(event.id, jobId);
      } catch (error) {
        this.logger.error(
          `Failed to enqueue outbox event ${event.id} (${event.eventType}): ${error.message}`,
          error.stack,
        );
        // This event stays PENDING; it will be retried on the next tick.
      }
    }

    if (dispatched.size === 0) {
      return;
    }

    // Persist each confirmed job ID to the exact matching row.
    // Individual updates (not a bulk IN + single jobId) ensure every row gets
    // its own job ID. The WHERE status = 'PENDING' predicate prevents
    // overwriting a row that was already updated by a concurrent pod.
    let persistedCount = 0;
    for (const [eventId, jobId] of dispatched) {
      try {
        const result = await this.prisma.outboxEvent.updateMany({
          where: { id: eventId, status: 'PENDING' },
          data: {
            status: 'DISPATCHED',
            jobId,
            processedAt: new Date(),
          },
        });

        if (result.count > 0) {
          persistedCount++;
        } else {
          // The row was already updated by a concurrent scheduler instance;
          // BullMQ jobId deduplication ensures only one job runs.
          this.logger.debug(
            `Outbox event ${eventId} already updated by concurrent instance — skipping`,
          );
        }
      } catch (dbError) {
        // DB update failed after a successful enqueue. The job is already in
        // BullMQ and will be processed. On the next poll this row is still
        // PENDING; the re-enqueue is deduplicated by BullMQ via the stable
        // jobId. Log the orphan so operators can reconcile if needed.
        this.logger.error(
          `DB update failed for outbox event ${eventId} (jobId=${jobId}). ` +
            `The job is already in BullMQ; a duplicate enqueue will be ` +
            `deduplicated on next poll. Error: ${dbError.message}`,
          dbError.stack,
        );
      }
    }

    this.logger.log(
      `Dispatched ${persistedCount}/${pendingEvents.length} pending notification events ` +
        `(${dispatched.size} enqueued, ${pendingEvents.length - dispatched.size} enqueue failures)`,
    );
  }

  /**
   * Enqueue a single outbox event in BullMQ and return the confirmed job ID.
   *
   * The job ID is set to `outbox-<idempotencyKey>` so that:
   * - Concurrent scheduler pods deduplicate via BullMQ's jobId uniqueness.
   * - A crash-then-replay cycle re-uses the same ID, preventing ghost jobs.
   *
   * Throws if the enqueue fails; the caller decides whether to retry.
   */
  private async enqueueEvent(outboxEvent: OutboxRow): Promise<string> {
    const eventTypeMatch = outboxEvent.eventType.match(/^NOTIFICATION:(.+)$/);
    if (!eventTypeMatch) {
      throw new Error(
        `Invalid notification event type format: ${outboxEvent.eventType}`,
      );
    }

    const eventType = eventTypeMatch[1];

    let payload: OutboxPayload;
    try {
      payload = JSON.parse(outboxEvent.payload) as OutboxPayload;
    } catch {
      throw new Error(
        `Outbox event ${outboxEvent.id} has invalid JSON payload`,
      );
    }

    const job: NotificationProcessorJob = {
      outboxEventId: outboxEvent.id,
      eventType,
      aggregateId: outboxEvent.aggregateId,
      recipientIds: Array.isArray(payload.recipientIds)
        ? payload.recipientIds
        : [],
      payload: payload as Record<string, any>,
      idempotencyKey: outboxEvent.idempotencyKey,
      retryCount: outboxEvent.retryCount ?? 0,
      maxRetries: outboxEvent.maxRetries ?? 5,
    };

    // Stable jobId enables idempotent re-enqueue: BullMQ silently ignores a
    // second add() call with the same jobId if the job is still active/waiting.
    const stableJobId = `outbox-${outboxEvent.idempotencyKey}`;

    const added = await this.notificationQueue.add(
      `notification:${eventType}`,
      job,
      {
        jobId: stableJobId,
        attempts: outboxEvent.maxRetries ?? 5,
        backoff: {
          type: 'exponential',
          delay: 2000, // 2s, 4s, 8s, 16s, 32s
        },
        removeOnComplete: {
          age: 3600, // Remove completed jobs after 1 hour
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours for analysis
        },
      },
    );

    if (!added.id) {
      throw new Error(
        `BullMQ did not return a job ID for outbox event ${outboxEvent.id}`,
      );
    }

    return added.id;
  }

  /**
   * Manual trigger to poll outbox immediately.
   * Useful for testing or urgent processing.
   */
  async pollOutboxImmediate(): Promise<number> {
    await this.pollOutbox();
    return this.prisma.outboxEvent.count({ where: { status: 'PENDING' } });
  }

  /**
   * Get outbox statistics.
   */
  async getOutboxStats(): Promise<{
    pending: number;
    dispatched: number;
    deadLetter: number;
    oldestPendingAge: number | null; // minutes
  }> {
    const [pending, dispatched, deadLetter] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.outboxEvent.count({ where: { status: 'DISPATCHED' } }),
      this.prisma.outboxEvent.count({ where: { status: 'DEAD_LETTER' } }),
    ]);

    const oldestPending = await this.prisma.outboxEvent.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    let oldestAge: number | null = null;
    if (oldestPending) {
      oldestAge = Math.floor(
        (Date.now() - oldestPending.createdAt.getTime()) / 60_000,
      );
    }

    return {
      pending,
      dispatched,
      deadLetter,
      oldestPendingAge: oldestAge,
    };
  }

  /**
   * Alert if the outbox is backing up.
   * Call from a monitoring endpoint.
   */
  async checkHealth(): Promise<{ healthy: boolean; issues: string[] }> {
    const stats = await this.getOutboxStats();
    const issues: string[] = [];

    if (stats.pending > 100) {
      issues.push(`High pending count: ${stats.pending}`);
    }

    if (stats.oldestPendingAge !== null && stats.oldestPendingAge > 5) {
      issues.push(
        `Oldest pending event is ${stats.oldestPendingAge} minutes old`,
      );
    }

    if (stats.deadLetter > 10) {
      issues.push(`High dead-letter count: ${stats.deadLetter}`);
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  /**
   * Delete DISPATCHED events older than the retention window.
   */
  async cleanupOldDispatchedEvents(
    retentionHours: number = 24,
  ): Promise<number> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - retentionHours);

    const result = await this.prisma.outboxEvent.deleteMany({
      where: {
        status: 'DISPATCHED',
        processedAt: { lt: cutoffTime },
      },
    });

    this.logger.log(
      `Cleaned up ${result.count} dispatched events older than ${retentionHours} hours`,
    );

    return result.count;
  }
}
