import { EventType } from '../enums/event-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';

export interface RenderedNotificationPayload {
  userId: string;
  channel: DeliveryChannel;
  rendered: {
    title?: string;
    subject?: string;
    body: string;
    html?: string;
    markdown?: string;
    actionUrl?: string;
  };
  eventType: EventType;
  metadata: Record<string, any>;
}

export interface ChannelDeliveryResult {
  success: boolean;
  error?: string;
  deliveryTimestamp?: Date;
  channelMessageId?: string; // Channel-specific message ID for tracking
}

/**
 * NotificationChannel
 * 
 * Base interface for all notification delivery channels.
 * Implementations handle the specifics of their delivery mechanism
 * (email, push, webhook, etc.) while conforming to this contract.
 */
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
   * @param payload Rendered notification with user context and metadata
   * @returns Delivery result with success status and optional error message
   */
  send(payload: RenderedNotificationPayload): Promise<ChannelDeliveryResult>;

  /**
   * Validate user configuration for this channel
   * @returns { valid: boolean, errors: string[] }
   */
  validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }>;

  /**
   * Optional: Get channel-specific metrics
   */
  getMetrics?(): Promise<{
    successCount: number;
    failureCount: number;
    averageDeliveryTimeMs: number;
  }>;
}