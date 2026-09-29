import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { NotificationProcessorJob } from './notification-processor.service';

/**
 * OutboxScheduler
 * 
 * Scheduled job that polls the outbox table for pending notification events.
 * Implements the transactional outbox pattern for guaranteed at-least-once delivery.
 * 
 * Flow:
 * 1. Query for PENDING outbox events (batch)
 * 2. Create BullMQ job for each event
 * 3. Update status to DISPATCHED
 * 4. On next run, only PENDING events are processed (failed jobs stay as PENDING)
 * 
 * Runs every 5 seconds (configurable)
 * Batch size: 50 events per poll
 */
@Injectable()
export class OutboxScheduler {
  private readonly logger = new Logger(OutboxScheduler.name);

  private readonly BATCH_SIZE = 50;
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds

  constructor(
    @InjectRepository(OutboxEvent)
    private outboxRepository: Repository<OutboxEvent>,
    @InjectQueue('notifications')
    private notificationQueue: Queue,
  ) {}

  /**
   * Poll outbox for pending events
   * Runs every 5 seconds via @Cron
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async pollOutbox(): Promise<void> {
    try {
      // Query pending events
      const pendingEvents = await this.outboxRepository.find({
        where: { status: 'PENDING' },
        order: { createdAt: 'ASC' },
        take: this.BATCH_SIZE,
      });

      if (pendingEvents.length === 0) {
        return; // No events to process
      }

      this.logger.debug(`Found ${pendingEvents.length} pending notification events`);

      // Process each event
      const jobIds: string[] = [];
      for (const event of pendingEvents) {
        try {
          const jobId = await this.createBullMQJob(event);
          jobIds.push(jobId);
        } catch (error) {
          this.logger.error(
            `Failed to create job for outbox event ${event.id}: ${error.message}`,
          );
        }
      }

      // Bulk update status to DISPATCHED for successfully created jobs
      if (jobIds.length > 0) {
        const eventIds = pendingEvents.slice(0, jobIds.length).map((e) => e.id);
        await this.outboxRepository.update(
          { id: In(eventIds) },
          { status: 'DISPATCHED', jobId: jobIds[0] }, // TODO: store per-event jobId
        );

        this.logger.log(
          `Dispatched ${jobIds.length}/${pendingEvents.length} pending notification events`,
        );
      }
    } catch (error) {
      this.logger.error(`Outbox polling failed: ${error.message}`, error.stack);
      // Continue polling on next interval despite errors
    }
  }

  /**
   * Create BullMQ job for outbox event
   */
  private async createBullMQJob(outboxEvent: OutboxEvent): Promise<string> {
    // Extract event type from outbox event type
    // Format: "NOTIFICATION:EVENT_TYPE"
    const eventTypeMatch = outboxEvent.eventType.match(/^NOTIFICATION:(.+)$/);
    if (!eventTypeMatch) {
      throw new Error(
        `Invalid notification event type format: ${outboxEvent.eventType}`,
      );
    }

    const eventType = eventTypeMatch[1];
    const payload = outboxEvent.payload as any;

    // Create job
    const job: NotificationProcessorJob = {
      outboxEventId: outboxEvent.id,
      eventType,
      aggregateId: outboxEvent.aggregateId,
      recipientIds: payload.recipientIds || [],
      payload: payload,
      idempotencyKey: outboxEvent.idempotencyKey,
      retryCount: outboxEvent.retryCount || 0,
      maxRetries: outboxEvent.maxRetries || 5,
    };

    // Add to queue with exponential backoff config
    const added = await this.notificationQueue.add(
      `notification:${eventType}`,
      job,
      {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000, // Initial delay: 2s, then 4s, 8s, 16s, 32s
        },
        removeOnComplete: {
          age: 3600, // Remove completed jobs after 1 hour
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours (for analysis)
        },
      },
    );

    return added.id;
  }

  /**
   * Manual trigger to poll outbox immediately
   * Useful for testing or urgent processing
   */
  async pollOutboxImmediate(): Promise<number> {
    await this.pollOutbox();
    return this.outboxRepository.count({ where: { status: 'PENDING' } });
  }

  /**
   * Get outbox statistics
   */
  async getOutboxStats(): Promise<{
    pending: number;
    dispatched: number;
    deadLetter: number;
    oldestPendingAge: number | null; // minutes
  }> {
    const [pending, dispatched, deadLetter] = await Promise.all([
      this.outboxRepository.count({ where: { status: 'PENDING' } }),
      this.outboxRepository.count({ where: { status: 'DISPATCHED' } }),
      this.outboxRepository.count({ where: { status: 'DEAD_LETTER' } }),
    ]);

    // Get oldest pending event
    const oldestPending = await this.outboxRepository.findOne({
      where: { status: 'PENDING' },
      order: { createdAt: 'ASC' },
    });

    let oldestAge: number | null = null;
    if (oldestPending) {
      oldestAge = Math.floor(
        (Date.now() - oldestPending.createdAt.getTime()) / 60000,
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
   * Alert if outbox is backing up
   * Call this from monitoring system
   */
  async checkHealth(): Promise<{ healthy: boolean; issues: string[] }> {
    const stats = await this.getOutboxStats();
    const issues: string[] = [];

    // Alert if too many pending
    if (stats.pending > 100) {
      issues.push(`High pending count: ${stats.pending}`);
    }

    // Alert if events are stuck
    if (stats.oldestPendingAge && stats.oldestPendingAge > 5) {
      issues.push(
        `Oldest pending event is ${stats.oldestPendingAge} minutes old`,
      );
    }

    // Alert if many dead-letters
    if (stats.deadLetter > 10) {
      issues.push(`High dead-letter count: ${stats.deadLetter}`);
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  /**
   * Cleanup dispatched events older than retention period
   */
  async cleanupOldDispatchedEvents(retentionHours: number = 24): Promise<number> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - retentionHours);

    const result = await this.outboxRepository.delete({
      status: 'DISPATCHED',
      processedAt: LessThan(cutoffTime),
    });

    const count = result.affected || 0;
    this.logger.log(
      `Cleaned up ${count} dispatched events older than ${retentionHours} hours`,
    );

    return count;
  }
}
