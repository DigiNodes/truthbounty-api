import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import * as moment from 'moment-timezone';

/**
 * PreferenceEnforcer
 * 
 * Enforces user notification preferences during delivery.
 * Handles:
 * - Channel enablement (in-app, email, push, webhook, websocket)
 * - Category subscriptions (event type filtering)
 * - Quiet hours (timezone-aware)
 * - Rate limiting (max per-day caps)
 * - Digest mode (batch delivery)
 */
@Injectable()
export class PreferenceEnforcer {
  private readonly logger = new Logger(PreferenceEnforcer.name);

  constructor(
    @InjectRepository(NotificationPreference)
    private preferenceRepository: Repository<NotificationPreference>,
  ) {}

  /**
   * Load preferences for a user, with defaults
   */
  async getPreferences(userId: string): Promise<NotificationPreference> {
    let pref = await this.preferenceRepository.findOne({
      where: { userId },
    });

    if (!pref) {
      // Create defaults
      pref = this.preferenceRepository.create({
        userId,
        channels: {
          [DeliveryChannel.IN_APP]: true,
          [DeliveryChannel.EMAIL]: true,
          [DeliveryChannel.PUSH]: false,
          [DeliveryChannel.WEBHOOK]: false,
          [DeliveryChannel.WEBSOCKET]: true,
        },
        categorySubscriptions: {},
        language: 'en',
      });
      pref = await this.preferenceRepository.save(pref);
    }

    return pref;
  }

  /**
   * Check if a channel is enabled for a user
   */
  async isChannelEnabled(userId: string, channel: DeliveryChannel): Promise<boolean> {
    const pref = await this.getPreferences(userId);
    return pref.channels?.[channel] ?? false;
  }

  /**
   * Check if a notification category is enabled for a user
   * Returns true if not explicitly disabled (opt-out model)
   */
  async isCategoryEnabled(userId: string, eventType: EventType): Promise<boolean> {
    const pref = await this.getPreferences(userId);

    // If no category subscriptions defined, use all-enabled default
    if (!pref.categorySubscriptions || Object.keys(pref.categorySubscriptions).length === 0) {
      return true;
    }

    // Explicit subscription setting
    return pref.categorySubscriptions[eventType] ?? true;
  }

  /**
   * Check if current time is within quiet hours
   * Returns true if SHOULD NOT notify (is in quiet period)
   */
  async isInQuietHours(userId: string): Promise<boolean> {
    const pref = await this.getPreferences(userId);

    if (!pref.quietHours?.enabled) {
      return false;
    }

    const { startTime, endTime, timezone } = pref.quietHours;

    if (!startTime || !endTime) {
      return false;
    }

    try {
      const userTz = timezone || 'UTC';
      const now = moment().tz(userTz);

      const start = moment.tz(startTime, 'HH:mm', userTz);
      const end = moment.tz(endTime, 'HH:mm', userTz);

      // Handle overnight quiet hours (e.g., 22:00 - 08:00)
      if (start.isAfter(end)) {
        return now.isAfter(start) || now.isBefore(end);
      }

      return now.isBetween(start, end, undefined, '[]');
    } catch (error) {
      this.logger.warn(`Failed to check quiet hours for user ${userId}: ${error.message}`);
      return false; // Don't block delivery on timing errors
    }
  }

  /**
   * Check if digest mode is enabled
   */
  async isDigestModeEnabled(userId: string): Promise<boolean> {
    const pref = await this.getPreferences(userId);
    return pref.digestPreferences?.enabled ?? false;
  }

  /**
   * Get digest delivery time for user
   * Returns HH:mm format
   */
  async getDigestDeliveryTime(userId: string): Promise<string> {
    const pref = await this.getPreferences(userId);
    return pref.digestPreferences?.deliveryTime ?? '09:00';
  }

  /**
   * Get digest frequency
   */
  async getDigestFrequency(userId: string): Promise<'DAILY' | 'WEEKLY'> {
    const pref = await this.getPreferences(userId);
    return pref.digestPreferences?.frequency ?? 'DAILY';
  }

  /**
   * Check if user has hit daily notification cap
   */
  async canDeliverNotification(userId: string, channel: DeliveryChannel): Promise<boolean> {
    const pref = await this.getPreferences(userId);

    // Check channel-specific limits
    if (channel === DeliveryChannel.EMAIL && pref.maxEmailsPerDay) {
      // TODO: Query delivery history for today
      // If count >= maxEmailsPerDay, return false
    }

    // Check general notification limit
    if (pref.maxNotificationsPerDay) {
      // TODO: Query delivery history for today
      // If count >= maxNotificationsPerDay, return false
    }

    return true;
  }

  /**
   * Update user preferences
   */
  async updatePreferences(
    userId: string,
    updates: Partial<NotificationPreference>,
  ): Promise<NotificationPreference> {
    let pref = await this.getPreferences(userId);
    Object.assign(pref, updates);
    pref.lastModifiedAt = new Date();
    return this.preferenceRepository.save(pref);
  }

  /**
   * Check all constraints for delivery
   * Returns { allowed, reason } to help with debugging
   */
  async shouldDeliver(
    userId: string,
    eventType: EventType,
    channel: DeliveryChannel,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Check channel enabled
    const channelEnabled = await this.isChannelEnabled(userId, channel);
    if (!channelEnabled) {
      return { allowed: false, reason: `Channel ${channel} disabled` };
    }

    // Check category enabled
    const categoryEnabled = await this.isCategoryEnabled(userId, eventType);
    if (!categoryEnabled) {
      return { allowed: false, reason: `Category ${eventType} disabled` };
    }

    // Check quiet hours
    const inQuietHours = await this.isInQuietHours(userId);
    if (inQuietHours && channel === DeliveryChannel.EMAIL) {
      // Only block email during quiet hours; other channels OK
      return { allowed: false, reason: 'In quiet hours (email only)' };
    }

    // Check rate limits
    const canDeliver = await this.canDeliverNotification(userId, channel);
    if (!canDeliver) {
      return { allowed: false, reason: `Daily limit reached for ${channel}` };
    }

    return { allowed: true };
  }

  /**
   * Get user's enabled channels
   */
  async getEnabledChannels(userId: string): Promise<DeliveryChannel[]> {
    const pref = await this.getPreferences(userId);
    return Object.keys(pref.channels || {})
      .filter((ch) => pref.channels[ch as DeliveryChannel])
      .map((ch) => ch as DeliveryChannel);
  }

  /**
   * Get user's email address for notifications
   */
  async getNotificationEmail(userId: string): Promise<string | null> {
    const pref = await this.getPreferences(userId);
    return pref.emailAddress || null;
  }

  /**
   * Check if user is unsubscribed
   */
  async isUnsubscribed(userId: string, unsubscribeToken: string): Promise<boolean> {
    const pref = await this.preferenceRepository.findOne({
      where: { userId, unsubscribeToken },
    });
    return !!pref;
  }

  /**
   * Unsubscribe user via token
   */
  async unsubscribeViaToken(unsubscribeToken: string): Promise<boolean> {
    const pref = await this.preferenceRepository.findOne({
      where: { unsubscribeToken },
    });

    if (!pref) {
      return false;
    }

    // Disable all channels
    pref.channels = {
      [DeliveryChannel.IN_APP]: false,
      [DeliveryChannel.EMAIL]: false,
      [DeliveryChannel.PUSH]: false,
      [DeliveryChannel.WEBHOOK]: false,
      [DeliveryChannel.WEBSOCKET]: false,
    };

    await this.preferenceRepository.save(pref);
    return true;
  }
}
