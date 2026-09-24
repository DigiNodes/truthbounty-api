import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel as ChannelType, Notification } from '../entities/notification.entity';
import { UserNotificationPreferences } from '../entities/notification.entity';
import { NotificationChannel, ChannelDeliveryResult } from './channel.interface';

@Injectable()
export class InAppChannel implements NotificationChannel {
  private readonly logger = new Logger(InAppChannel.name);
  readonly channelType = ChannelType.IN_APP;

  constructor(
    @InjectRepository(UserNotificationPreferences)
    private readonly preferencesRepository: Repository<UserNotificationPreferences>,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });
    
    if (!preferences) {
      return true; // Default to enabled if no preferences set
    }
    
    return preferences.enabledChannels[this.channelType] ?? true;
  }

  async send(notification: Notification): Promise<ChannelDeliveryResult> {
    this.logger.debug(
      `Sending in-app notification ${notification.id} to user ${notification.recipientId}`,
    );
    
    // In-app notifications are just stored in the database, they're retrieved via API
    // The WebSocket server will broadcast the new notification to connected clients
    
    return {
      success: true,
      deliveryTimestamp: new Date(),
    };
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    // In-app channel always has a valid config since it doesn't require any user configuration
    return { valid: true, errors };
  }
}