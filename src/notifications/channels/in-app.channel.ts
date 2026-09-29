import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel, ChannelDeliveryResult, RenderedNotificationPayload } from './channel.interface';
import { Notification } from '../entities/notification.entity';
import { NotificationStatus } from '../enums/notification-status.enum';

/**
 * InAppChannel
 * 
 * Delivers notifications as in-app messages stored in the database.
 * Users see these in the notification dashboard.
 * 
 * Features:
 * - Instant delivery (no external dependencies)
 * - Message history tracking
 * - Read/dismiss status tracking
 * - No delivery failures (always succeeds)
 */
@Injectable()
export class InAppChannel implements NotificationChannel {
  readonly channelType = 'IN_APP';
  private readonly logger = new Logger(InAppChannel.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    // In-app channel is always available
    return true;
  }

  async send(payload: RenderedNotificationPayload): Promise<ChannelDeliveryResult> {
    try {
      const notification = this.notificationRepository.create({
        userId: payload.userId,
        title: payload.rendered.subject || payload.rendered.title || payload.eventType,
        content: payload.rendered.body,
        message: payload.rendered.html || payload.rendered.body,
        metadata: {
          eventType: payload.eventType,
          channel: this.channelType,
          actionUrl: payload.rendered.actionUrl,
          ...payload.metadata,
        },
        status: NotificationStatus.DELIVERED,
        read: false,
      });

      const saved = await this.notificationRepository.save(notification);

      this.logger.debug(
        `In-app notification delivered to ${payload.userId} (id: ${saved.id})`,
      );

      return {
        success: true,
        deliveryTimestamp: new Date(),
        channelMessageId: saved.id,
      };
    } catch (error) {
      this.logger.error(
        `Failed to deliver in-app notification to ${payload.userId}: ${error.message}`,
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    // In-app channel has no config requirements
    return { valid: true, errors: [] };
  }

  async getMetrics(): Promise<any> {
    const total = await this.notificationRepository.count();
    const read = await this.notificationRepository.count({ where: { read: true } });

    return {
      totalNotifications: total,
      readNotifications: read,
      unreadCount: total - read,
    };
  }
}
