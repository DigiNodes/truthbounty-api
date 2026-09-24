import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel as ChannelType, Notification } from '../entities/notification.entity';
import { UserNotificationPreferences } from '../entities/notification.entity';
import { NotificationChannel, ChannelDeliveryResult } from './channel.interface';
import { NotificationGateway } from '../websockets/websocket.gateway';

@Injectable()
export class WebSocketChannel implements NotificationChannel {
  private readonly logger = new Logger(WebSocketChannel.name);
  readonly channelType = ChannelType.WEBSOCKET;

  constructor(
    @InjectRepository(UserNotificationPreferences)
    private readonly preferencesRepository: Repository<UserNotificationPreferences>,
    private readonly gateway: NotificationGateway,
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
      `Sending WebSocket notification ${notification.id} to user ${notification.recipientId}`,
    );

    const delivered = this.gateway.sendToUser(notification.recipientId, notification);
    
    if (delivered) {
      return {
        success: true,
        deliveryTimestamp: new Date(),
      };
    } else {
      return {
        success: false,
        error: 'User not connected to WebSocket server',
      };
    }
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    // WebSocket doesn't require any special configuration, just needs an active connection
    const isOnline = this.gateway.isUserOnline(userId);
    if (!isOnline) {
      errors.push('User is not currently connected to WebSocket server');
    }
    return { valid: isOnline, errors };
  }
}