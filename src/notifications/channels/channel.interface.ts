import type { RenderedNotificationPayload } from '../delivery/rendered-notification-payload';

/**
 * The canonical rendered payload lives in `../delivery/rendered-notification-payload`
 * and is re-exported here so channel implementations keep a single, stable
 * import path. Do not redeclare it locally.
 */
export type { RenderedNotificationPayload };

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
import { DeliveryChannel } from '../interfaces/notification.types';

export interface NotificationChannel {
  /**
   * Unique identifier for the channel (canonical DeliveryChannel)
   */
  readonly channelType: DeliveryChannel | string;

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
