import { Process, Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import {
  Notification,
  NotificationDeliveryHistory,
  DeliveryStatus,
  NotificationChannel as ChannelType,
} from '../entities/notification.entity';
import { NotificationChannel } from '../channels/channel.interface';
import { Inject } from '@nestjs/common';

interface NotificationJobData {
  notificationId: string;
  channel: string;
  retryCount: number;
}

@Processor('notifications')
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);
  
  // Map of channel types to their implementations
  private readonly channelMap: Map<string, NotificationChannel> = new Map();

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(NotificationDeliveryHistory)
    private readonly deliveryHistoryRepository: Repository<NotificationDeliveryHistory>,
    // Inject all channel implementations
    private readonly channels: NotificationChannel[],
  ) {
    // Build the channel map for quick lookup
    this.channels.forEach((channel) => {
      this.channelMap.set(channel.channelType, channel);
    });
  }

  @Process('deliver')
  async processDelivery(job: Job<NotificationJobData>) {
    const { notificationId, channel: channelType, retryCount } = job.data;
    
    this.logger.debug(
      `Processing delivery job for notification ${notificationId} via ${channelType}, attempt ${retryCount + 1}`,
    );

    // Get the channel implementation
    const channel = this.channelMap.get(channelType);
    if (!channel) {
      this.logger.error(`Unknown channel type: ${channelType}`);
      throw new Error(`Unknown channel: ${channelType}`);
    }

    // Get the notification
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId },
    });

    if (!notification) {
      this.logger.error(`Notification ${notificationId} not found`);
      throw new Error(`Notification not found: ${notificationId}`);
    }

    // Create or update delivery history
    let deliveryHistory = await this.deliveryHistoryRepository.findOne({
      where: {
        notificationId,
        channel: channelType as ChannelType,
      },
    });

    if (!deliveryHistory) {
      deliveryHistory = this.deliveryHistoryRepository.create({
        notificationId,
        recipientId: notification.recipientId,
        channel: channelType as ChannelType,
        status: DeliveryStatus.RETRYING,
        retryAttempts: retryCount,
      });
    } else {
      deliveryHistory.retryAttempts = retryCount;
      deliveryHistory.status = DeliveryStatus.RETRYING;
    }
    await this.deliveryHistoryRepository.save(deliveryHistory);

    try {
      // Check if channel is enabled for this user
      const isEnabled = await channel.isEnabled(notification.recipientId);
      if (!isEnabled) {
        this.logger.debug(
          `Channel ${channelType} is disabled for user ${notification.recipientId}, skipping delivery`,
        );
        deliveryHistory.status = DeliveryStatus.DELIVERED;
        await this.deliveryHistoryRepository.save(deliveryHistory);
        return;
      }

      // Send the notification
      const result = await channel.send(notification);

      if (result.success) {
        this.logger.debug(
          `Successfully delivered notification ${notificationId} via ${channelType}`,
        );
        deliveryHistory.status = DeliveryStatus.DELIVERED;
        deliveryHistory.deliveredAt = result.deliveryTimestamp || new Date();
        await this.deliveryHistoryRepository.save(deliveryHistory);
      } else {
        this.logger.warn(
          `Failed to deliver notification ${notificationId} via ${channelType}: ${result.error}`,
        );
        deliveryHistory.status = DeliveryStatus.FAILED;
        deliveryHistory.failureReason = result.error || 'Unknown error';
        await this.deliveryHistoryRepository.save(deliveryHistory);
        throw new Error(result.error || 'Delivery failed');
      }
    } catch (error) {
      this.logger.error(
        `Exception while delivering notification ${notificationId} via ${channelType}: ${error.message}`,
        error.stack,
      );
      deliveryHistory.status = DeliveryStatus.FAILED;
      deliveryHistory.failureReason = error.message;
      await this.deliveryHistoryRepository.save(deliveryHistory);
      throw error; // This will trigger a retry according to queue settings
    }
  }

  @Process('dead-letter')
  async processDeadLetter(job: Job<NotificationJobData>) {
    const { notificationId, channel: channelType } = job.data;
    
    this.logger.warn(
      `Moving notification ${notificationId} to dead letter queue for channel ${channelType}`,
    );

    // Update delivery history to mark as dead letter
    const deliveryHistory = await this.deliveryHistoryRepository.findOne({
      where: {
        notificationId,
        channel: channelType as ChannelType,
      },
    });

    if (deliveryHistory) {
      deliveryHistory.status = DeliveryStatus.DEAD_LETTER;
      await this.deliveryHistoryRepository.save(deliveryHistory);
    }
  }
}