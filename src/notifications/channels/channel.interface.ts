import { Notification } from '../entities/notification.entity';

export interface ChannelDeliveryResult {
  success: boolean;
  error?: string;
  deliveryTimestamp?: Date;
}

export interface NotificationChannel {
  /**
   * Unique identifier for the channel
   */
  readonly channelType: string;

  /**
   * Check if this channel is enabled for a specific user
   */
  isEnabled(userId: string): Promise<boolean>;

  /**
   * Send a notification through this channel
   */
  send(notification: Notification): Promise<ChannelDeliveryResult>;

  /**
   * Validate user configuration for this channel
   */
  validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }>;
}