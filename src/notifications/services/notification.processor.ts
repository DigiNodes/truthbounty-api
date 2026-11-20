import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { WebSocketService } from './websocket.service';
import { EmailService } from './email.service';
import { WebhookService } from './webhook.service';
import { DeliveryHistoryService } from './delivery-history.service';
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
    private readonly redisService: RedisService,
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

    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId },
    });

    if (!notification) {
      this.logger.error(`Notification ${notificationId} not found`);
      return;
    }

    const eventType = job.data.eventType ?? 'notification.send';
    const aggregateId = job.data.aggregateId ?? notificationId;
    const recipientId = job.data.userId ?? notification.userId;
    const idempotencyKey =
      job.data.deliveryIdempotencyKey ??
      job.data.idempotencyKey ??
      buildDeliveryIdempotencyKey({
        eventType,
        recipientId,
        channel,
        aggregateId,
      });

    // The durable claim — not Redis and not the BullMQ job id — decides whether
    // this worker may call a provider.
    const claim = await this.deliveryHistoryService.acquireClaim({
      idempotencyKey,
      notificationId,
      eventType,
      aggregateId,
      recipientId,
      channel,
    });

    if (!claim.acquired) {
      this.logger.warn(
        `[Idempotency Guard] Delivery claim not acquired (${claim.reason}): ${idempotencyKey}`,
      );
      if (claim.status === DeliveryStatus.DELIVERED) {
        await this.redisService.set(
          deliveredCacheKey(idempotencyKey),
          '1',
          this.DELIVERED_CACHE_TTL_SECONDS,
        );
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deduplicated: true,
        };
      }
      if (claim.status === DeliveryStatus.PERMANENT_FAILURE) {
        return {
          success: false,
          status: DeliveryStatus.PERMANENT_FAILURE,
          deduplicated: true,
        };
      }
      throw new Error(
        `Delivery claim not acquired (${claim.reason}): ${idempotencyKey}`,
      );
    }

    // Redis is an optimization only. A failed SETNX never grants or revokes
    // permission to send; the durable claim has already been acquired.
    await this.redisService.setnx(
      deliveryClaimCacheKey(idempotencyKey),
      claim.claimId!,
      Math.max(1, Math.ceil(DEFAULT_CLAIM_TTL_MS / 1000)),
    );

    let deliveryRecord =
      await this.deliveryHistoryService.findByIdempotencyKey(idempotencyKey);

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

      case DeliveryChannel.EMAIL:
        return this.emailService.sendNotificationEmail(
          notification,
          'user@example.com',
          idempotencyKey,
        );

      case DeliveryChannel.WEBHOOK:
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
