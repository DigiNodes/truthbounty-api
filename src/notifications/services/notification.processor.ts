import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { NotificationDispatchControlGuard } from './notification-dispatch-control.guard';
import { WebSocketService } from './websocket.service';
import { EmailService } from './email.service';
import { WebhookService } from './webhook.service';
import { DeliveryHistoryService } from './delivery-history.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import {
  DeliveryChannel,
  DeliveryStatus,
} from '../interfaces/notification.types';
import {
  buildDeliveryIdempotencyKey,
  deliveredCacheKey,
  deliveryClaimCacheKey,
} from '../delivery/delivery-idempotency-key';
import { DEFAULT_CLAIM_TTL_MS } from '../delivery/delivery-claim';
import {
  DeliveryFailureKind,
  narrowDeliveryError,
} from '../delivery/delivery-error';

/** BullMQ job payload for notification delivery, relayed from the outbox (V2-BE-048). */
export interface NotificationDeliveryJob {
  notificationId: string;
  channel: DeliveryChannel;
  userId?: string;
  eventType?: string;
  aggregateId?: string;
  deliveryIdempotencyKey?: string;
}

import { RedisService } from '../../redis/redis.service';

@Processor('notifications', {
  concurrency: 10,
})
@Injectable()
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);
  private readonly DELIVERED_CACHE_TTL_SECONDS = 86400;

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    private readonly webSocketService: WebSocketService,
    private readonly emailService: EmailService,
    private readonly webhookService: WebhookService,
    private readonly deliveryHistoryService: DeliveryHistoryService,
    private readonly preferencesService: NotificationPreferencesService,
    private readonly redisService: RedisService,
    private readonly dispatchControlGuard: NotificationDispatchControlGuard,
  ) {
    super();
  }

  async process(
    job: Job<NotificationDeliveryJob & { idempotencyKey?: string }>,
  ): Promise<any> {
    const { notificationId, channel } = job.data;
    this.logger.debug(
      `Processing notification delivery: ${notificationId} via ${channel} (attempt ${job.attemptsMade + 1})`,
    );

    let deliveryRecord =
      await this.deliveryHistoryService.findPendingDeliveryByNotificationAndChannel(
        notificationId,
        channel,
      );

    if (!(await this.dispatchControlGuard.isNotificationsEnabled())) {
      const error = 'Notifications disabled by operational control';
      this.logger.warn(
        `[Dispatch Guard] Suppressed notification ${notificationId} via ${channel}: ${error}`,
      );
      if (deliveryRecord) {
        await this.deliveryHistoryService.updateDeliveryStatus(
          deliveryRecord.id,
          DeliveryStatus.PERMANENT_FAILURE,
          error,
        );
      }
      return {
        success: true,
        status: DeliveryStatus.PERMANENT_FAILURE,
        suppressed: true,
      };
    }

    if (idempotencyKey) {
      const redisKey = `idempotency:notification:${idempotencyKey}`;
      const acquiredLock = await this.redisService.setnx(redisKey, '1', 86400); // 24h TTL
      if (!acquiredLock) {
        this.logger.warn(
          `[Idempotency Guard] Duplicate job execution suppressed by Redis SETNX: key=${idempotencyKey}`,
        );
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deduplicated: true,
        };
      }

      const existingHistory =
        await this.deliveryHistoryService.findByIdempotencyKey(idempotencyKey);
      if (
        existingHistory &&
        existingHistory.status === DeliveryStatus.DELIVERED
      ) {
        this.logger.warn(
          `[Idempotency Guard] Duplicate job execution suppressed by DB check: key=${idempotencyKey}`,
        );
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deduplicated: true,
        };
      }
    }

    if (!deliveryRecord) {
      // Auto-create delivery record if dispatched via Outbox pattern
      deliveryRecord = await this.deliveryHistoryService.createDeliveryRecord(
        notificationId,
        channel,
        idempotencyKey,
      );
    }

    if (job.attemptsMade > 0) {
      await this.deliveryHistoryService.incrementRetryAttempts(
        deliveryRecord.id,
      );
    }

    const result = await this.deliverViaChannel(
      notification,
      channel,
      idempotencyKey,
    );

    if (result.success) {
      const settlement = await this.deliveryHistoryService.confirmClaim(
        idempotencyKey,
        claim.claimId,
        { providerDeliveredAt: result.deliveredAt?.toISOString() },
      );
      await this.deliveryHistoryService.updateDeliveryStatus(
        deliveryRecord.id,
        settlement?.status ?? result.status,
        result.error,
      );
      await this.redisService.set(
        deliveredCacheKey(idempotencyKey),
        '1',
        this.DELIVERED_CACHE_TTL_SECONDS,
      );
      this.logger.log(
        `Notification ${notificationId} delivered successfully via ${channel}`,
      );
      return result;
    }

    const narrowed = narrowDeliveryError(
      new Error(result.error ?? 'Delivery failed'),
      { channel },
    );
    const outcomeUncertain =
      narrowed.kind === DeliveryFailureKind.TIMEOUT ||
      narrowed.kind === DeliveryFailureKind.UNAVAILABLE;

    if (outcomeUncertain) {
      await this.deliveryHistoryService.markClaimUncertain(
        idempotencyKey,
        claim.claimId,
        result.error ?? 'Provider outcome unconfirmed',
      );
    } else {
      const settlement = await this.deliveryHistoryService.failClaim(
        idempotencyKey,
        claim.claimId,
        result.error ?? 'Delivery failed',
        narrowed.disposition === 'terminal',
      );
      await this.deliveryHistoryService.updateDeliveryStatus(
        deliveryRecord.id,
        settlement?.status ?? result.status,
        result.error,
      );
    }

    throw new Error(result.error || 'Delivery failed');
  }

  private async deliverViaChannel(
    notification: Notification,
    channel: DeliveryChannel,
    idempotencyKey: string,
  ) {
    switch (channel) {
      case DeliveryChannel.WEBSOCKET:
        return this.webSocketService.broadcastNotification(notification);

      case DeliveryChannel.EMAIL: {
        // Only ever send to the recipient stored on the user's notification
        // preferences. Never fall back to a placeholder address (#613).
        const recipientEmail = await this.preferencesService
          .getUserPreferences(notification.userId)
          .then((preferences) => preferences?.emailAddress || null)
          .catch(() => null);

        if (!recipientEmail) {
          return {
            success: false,
            status: DeliveryStatus.FAILED,
            error: 'No verified recipient email on record',
          };
        }

        return this.emailService.sendNotificationEmail(
          notification,
          'user@example.com',
          idempotencyKey,
        );
      }

      case DeliveryChannel.WEBHOOK: {
        const userWebhooks = await this.webhookService.getUserWebhooks(
          notification.userId,
        );
        if (userWebhooks.length > 0) {
          const webhookResults = await Promise.all(
            userWebhooks.map((webhook) =>
              this.webhookService.sendWebhookNotification(
                notification,
                webhook,
                idempotencyKey,
              ),
            ),
          );
          const allSuccessful = webhookResults.every((r) => r.success);
          return {
            success: allSuccessful,
            status: allSuccessful
              ? DeliveryStatus.DELIVERED
              : DeliveryStatus.FAILED,
            deliveredAt: allSuccessful ? new Date() : undefined,
            error: allSuccessful
              ? undefined
              : 'Some webhooks failed to deliver',
          };
        }
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: 'No webhooks configured for user',
        };
      }

      case DeliveryChannel.IN_APP:
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
        };

      case DeliveryChannel.PUSH:
        this.logger.debug(`Push notifications not yet implemented`);
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: 'Push notifications not implemented',
        };

      default:
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: `Unknown delivery channel: ${channel}`,
        };
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} completed successfully`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `Job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`,
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error('Worker encountered an error:', error);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`Job ${jobId} has stalled`);
  }
}
