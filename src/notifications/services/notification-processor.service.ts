import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { NotificationOrchestrator } from './notification-orchestrator.service';
import { DeliveryTracker } from './delivery-tracker.service';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { EventType } from '../enums/event-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';
import { parseDeliveryChannel } from '../delivery/delivery-channel';
import { planDeliveryRetry } from '../delivery/delivery-retry.policy';

export interface NotificationProcessorJob {
  outboxEventId: string;
  eventType: EventType;
  aggregateId: string;
  recipientIds: string[];
  payload: Record<string, any>;
  idempotencyKey: string;
  retryCount?: number;
  maxRetries?: number;
}

/**
 * NotificationProcessor
 * 
 * BullMQ job processor that handles notification delivery.
 * 
 * Responsibilities:
 * 1. Dequeue jobs from BullMQ
 * 2. Load outbox event details
 * 3. Call orchestrator to deliver to users
 * 4. Handle errors and retries
 * 5. Update outbox status (DISPATCHED/DEAD_LETTER)
 * 
 * Job Flow:
 * OutboxScheduler → creates job → BullMQ queue
 *                                      ↓
 *                           NotificationProcessor
 *                                      ↓
 *                           Orchestrator.deliverNotification()
 *                                      ↓
 *                        Channel delivery (in-app, email, etc)
 *                                      ↓
 *                    Update DeliveryHistory + OutboxEvent status
 */
@Injectable()
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(OutboxEvent)
    private outboxRepository: Repository<OutboxEvent>,
    @InjectQueue('notifications')
    private notificationQueue: Queue,
    private orchestrator: NotificationOrchestrator,
    private deliveryTracker: DeliveryTracker,
    private preferenceEnforcer: PreferenceEnforcer,
  ) {}

  /**
   * Process a notification delivery job
   * This is the main entry point called by BullMQ worker
   */
  async processJob(job: Job<NotificationProcessorJob>): Promise<any> {
    const { outboxEventId, eventType, recipientIds, payload, idempotencyKey } = job.data;

    this.logger.log(
      `Processing notification job ${job.id}: ${eventType} to ${recipientIds.length} recipients`,
    );

    try {
      // Load outbox event
      const outboxEvent = await this.outboxRepository.findOne({
        where: { id: outboxEventId },
      });

      if (!outboxEvent) {
        this.logger.error(`Outbox event not found: ${outboxEventId}`);
        throw new Error(`Outbox event not found: ${outboxEventId}`);
      }

      // Update outbox status to processing
      outboxEvent.status = 'PROCESSING';
      await this.outboxRepository.save(outboxEvent);

      // Deliver to all recipients
      const deliveryResults: Record<string, any> = {};

      for (const userId of recipientIds) {
        try {
          // Check idempotency
          const shouldDeliver = await this.deliveryTracker.checkIdempotency(
            `${idempotencyKey}:${userId}`,
          );

          if (!shouldDeliver) {
            this.logger.debug(`Skipping duplicate delivery to ${userId}`);
            deliveryResults[userId] = { status: 'skipped', reason: 'duplicate' };
            continue;
          }

          // Check user preferences. The channel is resolved from the
          // publisher payload and falls back to in-app; a null channel is
          // never handed to the enforcer or the orchestrator.
          const preferenceChannel =
            parseDeliveryChannel(payload?.channel) ?? DeliveryChannel.IN_APP;
          const shouldNotify = await this.preferenceEnforcer.shouldDeliver(
            userId,
            eventType,
            preferenceChannel,
          );

          if (!shouldNotify.allowed) {
            this.logger.debug(`Delivery blocked for ${userId}: ${shouldNotify.reason}`);
            deliveryResults[userId] = { status: 'blocked', reason: shouldNotify.reason };
            continue;
          }

          // Orchestrate delivery via enabled channels
          await this.orchestrator.deliverNotification(eventType, [userId], payload);

          deliveryResults[userId] = { status: 'delivered' };
        } catch (error) {
          this.logger.error(`Error delivering to ${userId}: ${error.message}`);
          deliveryResults[userId] = { status: 'error', reason: error.message };
        }
      }

      // Mark outbox event as dispatched
      outboxEvent.status = 'DISPATCHED';
      outboxEvent.processedAt = new Date();
      await this.outboxRepository.save(outboxEvent);

      this.logger.log(
        `Notification job ${job.id} completed: ${JSON.stringify(deliveryResults)}`,
      );

      return { success: true, deliveryResults };
    } catch (error) {
      this.logger.error(`Notification job ${job.id} failed: ${error.message}`, error.stack);

      // Handle retry or dead-letter
      return await this.handleJobFailure(job, error, outboxEventId);
    }
  }

  /**
   * Handle job failure - retry or dead-letter
   */
  private async handleJobFailure(
    job: Job<NotificationProcessorJob>,
    error: Error,
    outboxEventId: string,
  ): Promise<any> {
    const outboxEvent = await this.outboxRepository.findOne({
      where: { id: outboxEventId },
    });

    if (!outboxEvent) {
      throw error;
    }

    // Classify the failure through the shared, deterministic retry policy.
    // Provider-specific fields are read only inside `narrowDeliveryError`, and
    // terminal kinds can never be resurrected by the retry budget.
    const plan = planDeliveryRetry(error, outboxEvent.retryCount ?? 0, {
      budget: { maxAttempts: outboxEvent.maxRetries || 5 },
    });

    if (plan.action === 'retry') {
      this.logger.warn(
        `Notification job retry ${plan.nextAttempt}/${outboxEvent.maxRetries || 5}: ${plan.reason}`,
      );

      outboxEvent.retryCount = plan.nextAttempt;
      outboxEvent.lastError = plan.error.message;
      outboxEvent.status = 'PENDING'; // Re-queue
      await this.outboxRepository.save(outboxEvent);

      // Throw to signal BullMQ to retry with exponential backoff
      throw new Error(`Retry ${outboxEvent.retryCount}: ${plan.error.message}`);
    }

    // Move to dead-letter: terminal failures land here immediately, retryable
    // failures only once the budget is exhausted.
    this.logger.error(
      `Moving notification to dead-letter (${plan.reason}): ${outboxEventId}`,
    );

    outboxEvent.status = 'DEAD_LETTER';
    outboxEvent.lastError = plan.error.message;
    outboxEvent.processedAt = new Date();
    await this.outboxRepository.save(outboxEvent);

    // Alert monitoring
    this.logger.error(
      `DEAD_LETTER: ${outboxEvent.eventType} - ${plan.error.message}`,
    );

    return {
      success: false,
      deadLettered: true,
      reason: plan.error.message,
    };
  }

  /**
   * Get processor metrics
   */
  async getMetrics(): Promise<{
    totalJobs: number;
    activeJobs: number;
    completedJobs: number;
    failedJobs: number;
    delayedJobs: number;
    successRate: number;
  }> {
    const counts = await this.notificationQueue.getJobCounts();

    const successRate =
      counts.completed > 0
        ? (counts.completed / (counts.completed + counts.failed)) * 100
        : 0;

    return {
      totalJobs: counts.completed + counts.failed,
      activeJobs: counts.active,
      completedJobs: counts.completed,
      failedJobs: counts.failed,
      delayedJobs: counts.delayed,
      successRate,
    };
  }

  /**
   * Get dead-letter queue events
   */
  async getDeadLetterEvents(
    skip: number = 0,
    take: number = 50,
  ): Promise<{ items: OutboxEvent[]; total: number }> {
    const [items, total] = await this.outboxRepository.findAndCount({
      where: { status: 'DEAD_LETTER' },
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return { items, total };
  }

  /**
   * Retry a dead-lettered event
   * Manual intervention to move back to processing queue
   */
  async retryDeadLetterEvent(outboxEventId: string): Promise<void> {
    const outboxEvent = await this.outboxRepository.findOne({
      where: { id: outboxEventId },
    });

    if (!outboxEvent) {
      throw new Error(`Outbox event not found: ${outboxEventId}`);
    }

    if (outboxEvent.status !== 'DEAD_LETTER') {
      throw new Error(`Event is not dead-lettered: ${outboxEvent.status}`);
    }

    // Reset for retry
    outboxEvent.status = 'PENDING';
    outboxEvent.retryCount = 0;
    outboxEvent.lastError = null;
    await this.outboxRepository.save(outboxEvent);

    this.logger.log(`Manually retrying dead-letter event: ${outboxEventId}`);
  }

  /**
   * Purge old completed events
   * Retention policy: keep events for 30 days
   */
  async purgeOldEvents(retentionDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.outboxRepository.delete({
      status: 'DISPATCHED',
      processedAt: () => `processed_at < '${cutoffDate.toISOString()}'`,
    });

    const deleted = result.affected || 0;
    this.logger.log(`Purged ${deleted} old notification events`);
    return deleted;
  }
}
