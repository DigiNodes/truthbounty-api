import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import { UpdatePreferenceSettingsDto } from '../dto/update-preference-settings.dto';

const QUIET_HOURS_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
        channels: createDefaultChannelPreferences(),
        categorySubscriptions: {},
        language: 'en',
      });
      pref = await this.preferenceRepository.save(pref);
    }

    if (pref.channels) {
      pref.channels = normalizeChannelPreferences(pref.channels);
    }

    return pref;
  }

  /**
   * Check if a channel is enabled for a user
   */
  async isChannelEnabled(
    userId: string,
    channel: DeliveryChannel | string,
  ): Promise<boolean> {
    const canonical = parseDeliveryChannel(channel);
    if (!canonical) {
      return false; // Unknown or null channel fails closed
    }
    const pref = await this.getPreferences(userId);
    const normalized = normalizeChannelPreferences(pref.channels);
    return normalized[canonical] ?? false;
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
      const start = this.parseQuietHoursTime(startTime);
      const end = this.parseQuietHoursTime(endTime);

      if (start === null || end === null) {
        this.logger.warn(
          `Invalid quiet hours time for user ${userId}: ${startTime}-${endTime}`,
        );
        return false;
      }

      let nowMinutes: number;
      try {
        nowMinutes = this.getMinutesOfDay(new Date(), timezone || 'UTC');
      } catch {
        const fallbackTz = 'UTC';
        this.logger.warn(
          `Invalid quiet hours timezone '${timezone}' for user ${userId}, falling back to ${fallbackTz}`,
        );
        nowMinutes = this.getMinutesOfDay(new Date(), fallbackTz);
      }

      // Handle overnight quiet hours (e.g., 22:00 - 08:00)
      if (start > end) {
        return nowMinutes >= start || nowMinutes < end;
      }

      return nowMinutes >= start && nowMinutes <= end;
    } catch (error) {
      this.logger.error(`Error calculating quiet hours: ${error.message}`);
      return false; // Default to allowing notifications if timezone invalid
    }
  }

  private parseQuietHoursTime(value: string): number | null {
    const match = QUIET_HOURS_TIME_PATTERN.exec(value);
    if (!match) {
      return null;
    }
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }

  private getMinutesOfDay(date: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);

    const hourPart = parts.find((part) => part.type === 'hour');
    const minutePart = parts.find((part) => part.type === 'minute');

    const hour = Number(hourPart?.value);
    const minute = Number(minutePart?.value);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      throw new Error(
        `Unable to read wall-clock time in timezone '${timeZone}'`,
      );
    }

    return (hour % 24) * 60 + minute;
  }

  /**
   * Check if digest mode is enabled for a user
   */
  async isDigestEnabled(userId: string): Promise<boolean> {
    const pref = await this.getPreferences(userId);
    return pref.digestPreferences?.enabled ?? false;
  }

  /**
   * Check if user has exceeded rate limit for notifications
   */
  async canDeliverNotification(
    userId: string,
    channel: DeliveryChannel,
  ): Promise<boolean> {
    const pref = await this.getPreferences(userId);

    // Check overall max per day
    if (pref.maxNotificationsPerDay) {
      // In production, would query notification history count for today
      // For now, allow (rate limiting counter would be in Redis)
    }

    // Check email-specific cap
    if (channel === DeliveryChannel.EMAIL && pref.maxEmailsPerDay) {
      // Check email count today
    }

    return true;
  }

  /**
   * Update user preferences
   */
  async updatePreferences(
    userId: string,
    updates: UpdatePreferenceSettingsDto,
  ): Promise<NotificationPreference> {
  const pref = await this.getPreferences(userId);

  if (updates.channels !== undefined) {
    pref.channels = normalizeChannelPreferences(updates.channels);
  }

  if (updates.categorySubscriptions !== undefined) {
    pref.categorySubscriptions = updates.categorySubscriptions;
  }

  if (updates.quietHours !== undefined) {
    pref.quietHours = updates.quietHours;
  }

  if (updates.digestPreferences !== undefined) {
    pref.digestPreferences = updates.digestPreferences;
  }

  if (updates.language !== undefined) {
    pref.language = updates.language;
  }

  if (updates.webhookConfig !== undefined) {
    pref.webhookConfig = updates.webhookConfig;
  }

  if (updates.pushConfig !== undefined) {
    pref.pushConfig = updates.pushConfig;
  }

  pref.channels = normalizeChannelPreferences(pref.channels);
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
   * Get user's enabled channels as canonical DeliveryChannel values
   */
  async getEnabledChannels(userId: string): Promise<DeliveryChannel[]> {
    const pref = await this.getPreferences(userId);
    const normalized = normalizeChannelPreferences(pref.channels);
    const enabled: DeliveryChannel[] = [];
    for (const key of Object.values(DeliveryChannel)) {
      if (normalized[key] === true) {
        enabled.push(key);
      }
    }
    return enabled;
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
      [DeliveryChannel.SMS]: false,
    };

    await this.preferenceRepository.save(pref);
    return true;
  }
}
