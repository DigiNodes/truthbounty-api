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
  NotificationDeliveryJob 
} from '../interfaces/notification.types';

@Processor('notifications', {
  concurrency: 10,
})
@Injectable()
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    private readonly webSocketService: WebSocketService,
    private readonly emailService: EmailService,
    private readonly webhookService: WebhookService,
    private readonly deliveryHistoryService: DeliveryHistoryService,
  ) {
    super();
  }

  async process(job: Job<NotificationDeliveryJob>): Promise<any> {
    const { notificationId, channel } = job.data;
    this.logger.debug(`Processing notification delivery: ${notificationId} via ${channel} (attempt ${job.attemptsMade + 1})`);

    const deliveryRecord = await this.deliveryHistoryService.findPendingDeliveryByNotificationAndChannel(
      notificationId,
      channel
    );

    if (!deliveryRecord) {
      this.logger.warn(`No pending delivery record found for ${notificationId} via ${channel}`);
      return;
    }

    if (job.attemptsMade > 0) {
      await this.deliveryHistoryService.incrementRetryAttempts(deliveryRecord.id);
    }

    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId },
    });

    if (!notification) {
      this.logger.error(`Notification ${notificationId} not found`);
      await this.deliveryHistoryService.updateDeliveryStatus(
        deliveryRecord.id,
        DeliveryStatus.FAILED,
        'Notification not found in database'
      );
      return;
    }

    const result = await this.deliverViaChannel(notification, channel);
    
    await this.deliveryHistoryService.updateDeliveryStatus(
      deliveryRecord.id,
      result.status,
      result.error
    );

    if (!result.success) {
      throw new Error(result.error || 'Delivery failed');
    }

    this.logger.log(`Notification ${notificationId} delivered successfully via ${channel}`);
    return result;
  }

  private async deliverViaChannel(notification: Notification, channel: DeliveryChannel) {
    switch (channel) {
      case DeliveryChannel.WEBSOCKET:
        return this.webSocketService.broadcastNotification(notification);
      
      case DeliveryChannel.EMAIL:
        return this.emailService.sendNotificationEmail(notification, 'user@example.com');
      
      case DeliveryChannel.WEBHOOK:
        const userWebhooks = await this.webhookService.getUserWebhooks(notification.userId);
        if (userWebhooks.length > 0) {
          const webhookResults = await Promise.all(
            userWebhooks.map(webhook => 
              this.webhookService.sendWebhookNotification(notification, webhook)
            )
          );
          const allSuccessful = webhookResults.every(r => r.success);
          return {
            success: allSuccessful,
            status: allSuccessful ? DeliveryStatus.DELIVERED : DeliveryStatus.FAILED,
            deliveredAt: allSuccessful ? new Date() : undefined,
            error: allSuccessful ? undefined : 'Some webhooks failed to deliver',
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
    this.logger.error(`Job ${job.id} failed after ${job.attemptsMade} attempts: ${error.message}`);
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