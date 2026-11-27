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
import { buildDeliveryIdempotencyKey } from '../delivery/delivery-idempotency-key';

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
    const { outboxEventId, eventType, recipientIds, payload } = job.data;

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
          // Per recipient/channel claims are acquired by the orchestrator.
          // This read-only check only short-circuits already confirmed work.
          const preferenceChannel =
            parseDeliveryChannel(payload?.channel) ?? DeliveryChannel.IN_APP;
          const deliveryIdempotencyKey = buildDeliveryIdempotencyKey({
            eventType,
            recipientId: userId,
            channel: preferenceChannel,
            aggregateId: payload?.aggregateId ?? job.data.aggregateId,
          });

          if (await this.deliveryTracker.isDelivered(deliveryIdempotencyKey)) {
            this.logger.debug(`Skipping duplicate delivery to ${userId}`);
            deliveryResults[userId] = {
              status: 'skipped',
              reason: 'duplicate',
            };
            continue;
          }

          // Check user preferences. The channel is resolved from the
          // publisher payload and falls back to in-app; a null channel is
          // never handed to the enforcer or the orchestrator.
          const shouldNotify = await this.preferenceEnforcer.shouldDeliver(
            userId,
            eventType,
            preferenceChannel,
          );

          if (!shouldNotify.allowed) {
            this.logger.debug(
              `Delivery blocked for ${userId}: ${shouldNotify.reason}`,
            );
            deliveryResults[userId] = {
              status: 'blocked',
              reason: shouldNotify.reason,
            };
            continue;
          }

          // Orchestrate delivery via enabled channels
          await this.orchestrator.deliverNotification(eventType, [userId], {
            ...payload,
            aggregateId: payload?.aggregateId ?? job.data.aggregateId,
            notificationId:
              payload?.notificationId ?? job.data.aggregateId ?? outboxEventId,
          });

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

      // Log detailed outcomes for observability
      this.logger.log(
        `Notification job ${job.id} delivery complete: ` +
        `${deliveryResult.successfulRecipients}/${deliveryResult.totalRecipients} recipients succeeded, ` +
        `${deliveryResult.skippedRecipients} skipped, ` +
        `${deliveryResult.retryableRecipients} retryable failures, ` +
        `${deliveryResult.terminalRecipients} terminal failures`,
      );

      // Determine outbox event final state based on delivery outcomes
      const finalStatus = this.determineOutboxStatus(deliveryResult, outboxEvent);

      if (finalStatus === 'DISPATCHED') {
        // At least one recipient was successfully delivered
        outboxEvent.status = 'DISPATCHED';
        outboxEvent.processedAt = new Date();
        outboxEvent.metadata = {
          ...outboxEvent.metadata,
          deliveryResult: this.serializeDeliveryResult(deliveryResult),
        };
        await this.outboxRepository.save(outboxEvent);

        // Link all successful deliveries to this outbox event for audit trail
        await this.linkDeliveryEvidenceToOutbox(outboxEventId, deliveryResult);

        this.logger.log(
          `Notification job ${job.id} marked DISPATCHED: ${deliveryResult.successfulRecipients} successful deliveries`,
        );

        return {
          success: true,
          dispatched: true,
          deliveryResult: this.serializeDeliveryResult(deliveryResult),
        };
      } else if (finalStatus === 'RETRY') {
        // Some recipients have retryable failures and no successes
        // Extract retry state to track which channel-recipient pairs need retry
        const retryState = extractRetryState(
          outboxEventId,
          eventType,
          idempotencyKey,
          outboxEvent.retryCount ?? 0,
          outboxEvent.maxRetries ?? 5,
          deliveryResult,
          payload,
        );

        this.logger.log(
          `Notification job ${job.id} retry state: ${summarizeRetryState(retryState)}`,
        );

        // Store retry state in outbox metadata for audit and recovery
        outboxEvent.metadata = {
          ...outboxEvent.metadata,
          retryState: serializeRetryState(retryState),
          lastDeliveryResult: this.serializeDeliveryResult(deliveryResult),
        };
        await this.outboxRepository.save(outboxEvent);

        const retryError = this.createRetryError(deliveryResult);
        return await this.handleJobFailure(job, retryError, outboxEventId);
      } else {
        // All recipients failed terminally or were skipped
        outboxEvent.status = 'DEAD_LETTER';
        outboxEvent.lastError = this.summarizeFailures(deliveryResult);
        outboxEvent.processedAt = new Date();
        outboxEvent.metadata = {
          ...outboxEvent.metadata,
          deliveryResult: this.serializeDeliveryResult(deliveryResult),
        };
        await this.outboxRepository.save(outboxEvent);

        this.logger.error(
          `Notification job ${job.id} dead-lettered: no successful deliveries, ` +
          `${deliveryResult.terminalRecipients} terminal failures, ` +
          `${deliveryResult.skippedRecipients} skipped`,
        );

        return {
          success: false,
          deadLettered: true,
          reason: this.summarizeFailures(deliveryResult),
          deliveryResult: this.serializeDeliveryResult(deliveryResult),
        };
      }
    } catch (error) {
      this.logger.error(
        `Notification job ${job.id} failed: ${error.message}`,
        error.stack,
      );

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
   * Determine the final outbox event status based on delivery outcomes.
   * 
   * Policy:
   * - DISPATCHED: At least one recipient was successfully delivered to at least one channel
   * - RETRY: No successes, but at least one retryable failure (and we haven't exhausted retries)
   * - DEAD_LETTER: No successes and either all terminal failures or retry budget exhausted
   */
  private determineOutboxStatus(
    result: NotificationDeliveryResult,
    outboxEvent: OutboxEvent,
  ): 'DISPATCHED' | 'RETRY' | 'DEAD_LETTER' {
    // If any recipient was successfully delivered, mark as dispatched
    if (result.shouldDispatch) {
      return 'DISPATCHED';
    }

    // If we have retryable recipients and haven't exhausted retries, retry
    if (result.retryableRecipients > 0) {
      const currentRetry = outboxEvent.retryCount ?? 0;
      const maxRetries = outboxEvent.maxRetries ?? 5;
      if (currentRetry < maxRetries) {
        return 'RETRY';
      }
    }

    // Everything else goes to dead-letter
    return 'DEAD_LETTER';
  }

  /**
   * Create an error for retry purposes from delivery results.
   */
  private createRetryError(result: NotificationDeliveryResult): Error {
    const retryableRecipients = result.recipients.filter(shouldRetryRecipient);
    const channelErrors = retryableRecipients.flatMap((r) =>
      r.channels
        .filter((c) => c.outcome === DeliveryOutcome.RETRYABLE_FAILURE)
        .map((c) => `${r.userId}/${c.channel}: ${c.errorMessage}`),
    );

    return new Error(
      `Retryable delivery failures: ${channelErrors.slice(0, 3).join('; ')}` +
      (channelErrors.length > 3 ? ` and ${channelErrors.length - 3} more` : ''),
    );
  }

  /**
   * Summarize all failures for dead-letter logging.
   */
  private summarizeFailures(result: NotificationDeliveryResult): string {
    const parts: string[] = [];

    if (result.terminalRecipients > 0) {
      parts.push(`${result.terminalRecipients} terminal failures`);
    }
    if (result.skippedRecipients > 0) {
      parts.push(`${result.skippedRecipients} skipped`);
    }
    if (result.retryableRecipients > 0) {
      parts.push(`${result.retryableRecipients} retry budget exhausted`);
    }

    return parts.join(', ') || 'Complete delivery failure';
  }

  /**
   * Serialize delivery result for storage in outbox metadata.
   * Includes only the essential information to keep metadata size manageable.
   */
  private serializeDeliveryResult(result: NotificationDeliveryResult): any {
    return {
      summary: {
        totalRecipients: result.totalRecipients,
        successfulRecipients: result.successfulRecipients,
        skippedRecipients: result.skippedRecipients,
        retryableRecipients: result.retryableRecipients,
        terminalRecipients: result.terminalRecipients,
        anySuccess: result.anySuccess,
        completeFailure: result.completeFailure,
      },
      recipients: result.recipients.map((r) => ({
        userId: r.userId,
        succeeded: r.succeeded,
        successCount: r.successCount,
        channels: r.channels.map((c) => ({
          channel: c.channel,
          outcome: c.outcome,
          deliveredAt: c.deliveredAt?.toISOString(),
          providerMessageId: c.providerMessageId,
          failureKind: c.failureKind,
          reason: c.reason,
          errorMessage: c.errorMessage,
        })),
      })),
    };
  }

  /**
   * Link delivery evidence to outbox event for audit trail.
   * 
   * Creates bidirectional links between DeliveryHistory records and the
   * OutboxEvent, enabling reconstruction of which deliveries resulted from
   * which outbox event. Only links provider-confirmed deliveries (those with
   * providerMessageId) to maintain strong evidence chain.
   */
  private async linkDeliveryEvidenceToOutbox(
    outboxEventId: string,
    deliveryResult: NotificationDeliveryResult,
  ): Promise<void> {
    const linkPromises: Promise<void>[] = [];

    for (const recipient of deliveryResult.recipients) {
      if (!recipient.succeeded) continue;

      for (const channel of recipient.channels) {
        if (
          channel.outcome === DeliveryOutcome.DELIVERED &&
          channel.idempotencyKey &&
          channel.providerMessageId
        ) {
          // Link provider-confirmed deliveries to outbox event
          linkPromises.push(
            this.deliveryTracker
              .linkDeliveryToOutboxEvent(channel.idempotencyKey, outboxEventId)
              .catch((error) => {
                this.logger.warn(
                  `Failed to link delivery ${channel.idempotencyKey} to outbox ${outboxEventId}: ${error.message}`,
                );
              }),
          );
        }
      }
    }

    // Execute all links in parallel
    if (linkPromises.length > 0) {
      await Promise.allSettled(linkPromises);
      this.logger.debug(
        `Linked ${linkPromises.length} provider-confirmed deliveries to outbox event ${outboxEventId}`,
      );
    }
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
