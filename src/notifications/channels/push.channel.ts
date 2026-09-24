import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel as ChannelType, Notification } from '../entities/notification.entity';
import { UserNotificationPreferences } from '../entities/notification.entity';
import { NotificationChannel, ChannelDeliveryResult } from './channel.interface';

@Injectable()
export class PushChannel implements NotificationChannel {
  private readonly logger = new Logger(PushChannel.name);
  readonly channelType = ChannelType.PUSH;

  constructor(
    @InjectRepository(UserNotificationPreferences)
    private readonly preferencesRepository: Repository<UserNotificationPreferences>,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });
    
    if (!preferences || !preferences.pushSubscription) {
      return false;
    }
    
    return preferences.enabledChannels[this.channelType] ?? false;
  }

  async send(notification: Notification): Promise<ChannelDeliveryResult> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId: notification.recipientId },
    });

    if (!preferences?.pushSubscription?.endpoint) {
      return {
        success: false,
        error: 'No push subscription configured for user',
      };
    }

    this.logger.debug(
      `Sending push notification ${notification.id} to user ${notification.recipientId}`,
    );

    // In a real implementation, this would use a service like Firebase Cloud Messaging (FCM),
    // Apple Push Notification Service (APNs), or a web push library to send the notification
    // to the user's device
    
    const pushPayload = {
      title: notification.title,
      body: notification.message,
      data: {
        notificationId: notification.id,
        type: notification.type,
        ...notification.metadata,
      },
    };

    this.logger.debug(`Push payload: ${JSON.stringify(pushPayload)}`);

    return {
      success: true,
      deliveryTimestamp: new Date(),
    };
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      errors.push('No user preferences found');
      return { valid: false, errors };
    }

    if (!preferences.pushSubscription) {
      errors.push('No push subscription configured');
      return { valid: false, errors };
    }

    if (!preferences.pushSubscription.endpoint) {
      errors.push('Push subscription endpoint not provided');
    }

    if (!preferences.pushSubscription.keys?.p256dh || !preferences.pushSubscription.keys?.auth) {
      errors.push('Push subscription encryption keys missing');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}