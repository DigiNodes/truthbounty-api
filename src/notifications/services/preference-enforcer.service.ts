import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';
import { EventType } from '../enums/event-type.enum';
import { RedisService } from '../../redis/redis.service';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { Notification } from '../entities/notification.entity';
import {
  parseDeliveryChannel,
  normalizeChannelPreferences,
  createDefaultChannelPreferences,
} from '../delivery/delivery-channel';

const QUIET_HOURS_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Fields ordinary preference updates may change.
 *
 * `webhookConfig`, `userId`, `id`, `unsubscribeToken` and timestamps are
 * deliberately excluded: webhook secrets are write-only and handled by
 * WebhookPreferencesService, and the remaining fields are server-owned
 * (PREWAVE-BE-149/#849).
 */
const UPDATABLE_PREFERENCE_FIELDS = [
  'channels',
  'categorySubscriptions',
  'quietHours',
  'digestPreferences',
  'language',
  'maxNotificationsPerDay',
  'maxEmailsPerDay',
  'emailAddress',
  'pushConfig',
] as const;

/**
 * EMAIL channels eligible for the email-specific cap.
 */
const EMAIL_CHANNELS: ReadonlySet<DeliveryChannel> = new Set([DeliveryChannel.EMAIL]);

/**
 * Channels that are counted towards the overall daily notification cap.
 * Digest notifications are excluded; they go through a separate path.
 */
const QUOTA_ELIGIBLE_CHANNELS: ReadonlySet<DeliveryChannel> = new Set([
  DeliveryChannel.IN_APP,
  DeliveryChannel.EMAIL,
  DeliveryChannel.PUSH,
  DeliveryChannel.WEBHOOK,
  DeliveryChannel.WEBSOCKET,
  DeliveryChannel.SMS,
]);

/**
 * Result of a quota-reservation attempt.
 */
export interface QuotaResult {
  /** Whether the delivery is permitted under the current cap. */
  allowed: boolean;
  /** Machine-readable denial reason when allowed=false. */
  reason?: 'overall_cap_reached' | 'email_cap_reached';
  /** ISO-8601 timestamp of the next UTC calendar-day reset (00:00:00 UTC). */
  resetAt?: string;
}

/**
 * Atomically check and increment a Redis counter with a calendar-day TTL.
 *
 * Returns the new counter value after increment, or throws if Redis is
 * unavailable (callers must handle the throw and fall back to the DB).
 *
 * Lua guarantees atomicity across the INCR + EXPIREAT pair so concurrent
 * workers on separate instances cannot race past the cap.
 */
const LUA_INCR_CALDAY = `
local key     = KEYS[1]
local cap     = tonumber(ARGV[1])
local expiry  = tonumber(ARGV[2])
local current = redis.call('INCR', key)
if current == 1 then
  redis.call('EXPIREAT', key, expiry)
end
return current
`;

/**
 * PreferenceEnforcer
 * 
 * Enforces user notification preferences during delivery.
 * Handles:
 * - Channel enablement (in-app, email, push, webhook, websocket)
 * - Category subscriptions (event type filtering)
 * - Quiet hours (timezone-aware)
 * - Rate limiting (max per-day caps) — atomically enforced via Redis INCR
 * - Digest mode (batch delivery)
 */
@Injectable()
export class PreferenceEnforcer {
  private readonly logger = new Logger(PreferenceEnforcer.name);

  constructor(
    @InjectRepository(NotificationPreference)
    private preferenceRepository: Repository<NotificationPreference>,
    @InjectRepository(DeliveryHistory)
    private deliveryHistoryRepository: Repository<DeliveryHistory>,
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    private redisService: RedisService,
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
   * Atomically check and reserve quota for a notification delivery.
   *
   * Policy:
   *  - Window: UTC calendar day (resets at 00:00:00 UTC).
   *  - Overall cap: maxNotificationsPerDay across all QUOTA_ELIGIBLE_CHANNELS.
   *  - Email cap: maxEmailsPerDay for EMAIL channel only.
   *  - Null/undefined cap = unlimited.
   *  - Idempotent deliveries (same idempotency key already delivered) do not
   *    consume quota; callers should check idempotency before calling this.
   *  - If Redis is unavailable the method falls back to a DB count. The DB
   *    count is a read-then-check (not atomic) but is the safe-degraded path.
   *  - If even the DB fallback fails, the method denies delivery (fail-closed).
   *
   * @param userId   The recipient user id.
   * @param channel  The delivery channel being attempted.
   * @returns QuotaResult indicating whether delivery is permitted.
   */
  async canDeliverNotification(
    userId: string,
    channel: DeliveryChannel,
  ): Promise<QuotaResult> {
    const pref = await this.getPreferences(userId);

    // Calculate the UTC midnight that ends today (= first second of tomorrow).
    const resetAt = this.utcMidnightTimestamp();
    const resetAtIso = new Date(resetAt * 1000).toISOString();

    // ── Overall daily cap ───────────────────────────────────────────────────
    if (
      pref.maxNotificationsPerDay != null &&
      QUOTA_ELIGIBLE_CHANNELS.has(channel)
    ) {
      const overallKey = `quota:overall:${userId}:${this.utcDateKey()}`;
      const overallCount = await this.atomicIncrement(
        overallKey,
        pref.maxNotificationsPerDay,
        resetAt,
      );

      if (overallCount === null) {
        // Redis unavailable — fall back to DB count (read-only, not atomic).
        const dbCount = await this.countTodayDeliveriesFromDb(userId, null);
        if (dbCount >= pref.maxNotificationsPerDay) {
          return {
            allowed: false,
            reason: 'overall_cap_reached',
            resetAt: resetAtIso,
          };
        }
      } else if (overallCount > pref.maxNotificationsPerDay) {
        // Undo the increment we just made — we're over the cap.
        await this.decrementQuota(overallKey).catch(() => {/* best-effort */});
        return {
          allowed: false,
          reason: 'overall_cap_reached',
          resetAt: resetAtIso,
        };
      }
    }

    // ── Email-specific daily cap ─────────────────────────────────────────────
    if (pref.maxEmailsPerDay != null && EMAIL_CHANNELS.has(channel)) {
      const emailKey = `quota:email:${userId}:${this.utcDateKey()}`;
      const emailCount = await this.atomicIncrement(
        emailKey,
        pref.maxEmailsPerDay,
        resetAt,
      );

      if (emailCount === null) {
        // DB fallback.
        const dbEmailCount = await this.countTodayDeliveriesFromDb(
          userId,
          DeliveryChannel.EMAIL,
        );
        if (dbEmailCount >= pref.maxEmailsPerDay) {
          // Roll back the overall counter we may have already incremented.
          if (pref.maxNotificationsPerDay != null) {
            const overallKey = `quota:overall:${userId}:${this.utcDateKey()}`;
            await this.decrementQuota(overallKey).catch(() => {/* best-effort */});
          }
          return {
            allowed: false,
            reason: 'email_cap_reached',
            resetAt: resetAtIso,
          };
        }
      } else if (emailCount > pref.maxEmailsPerDay) {
        await this.decrementQuota(emailKey).catch(() => {/* best-effort */});
        // Roll back overall counter too.
        if (pref.maxNotificationsPerDay != null) {
          const overallKey = `quota:overall:${userId}:${this.utcDateKey()}`;
          await this.decrementQuota(overallKey).catch(() => {/* best-effort */});
        }
        return {
          allowed: false,
          reason: 'email_cap_reached',
          resetAt: resetAtIso,
        };
      }
    }

    return { allowed: true };
  }

  // ── Private quota helpers ──────────────────────────────────────────────────

  /**
   * Returns the UTC "YYYY-MM-DD" key for today, used as part of the Redis key
   * so the counter automatically partitions by calendar day.
   */
  private utcDateKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Returns the Unix timestamp (seconds) of midnight UTC that starts tomorrow,
   * i.e. the moment the current calendar day resets.
   */
  private utcMidnightTimestamp(): number {
    const now = new Date();
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    return Math.floor(midnight.getTime() / 1000);
  }

  /**
   * Atomically increment a Redis counter, setting an expiry on first creation.
   *
   * Returns the new counter value after increment, or null when Redis is
   * unavailable (callers must fall back to the DB).
   *
   * @param key      Redis key.
   * @param _cap     The cap (not enforced here — enforcement is in the caller).
   * @param expiry   Unix timestamp at which the key should expire.
   */
  private async atomicIncrement(
    key: string,
    _cap: number,
    expiry: number,
  ): Promise<number | null> {
    try {
      const result = await this.redisService.eval(
        LUA_INCR_CALDAY,
        1,
        key,
        String(_cap),
        String(expiry),
      );
      return typeof result === 'number' ? result : Number(result);
    } catch (err) {
      this.logger.warn(
        `Redis quota increment failed for key ${key}: ${(err as Error).message}. Falling back to DB.`,
      );
      return null;
    }
  }

  /**
   * Decrement a Redis counter by 1 (best-effort rollback on cap exceeded).
   */
  private async decrementQuota(key: string): Promise<void> {
    try {
      await this.redisService.eval(
        `return redis.call('DECR', KEYS[1])`,
        1,
        key,
      );
    } catch {
      // best-effort — do not propagate
    }
  }

  /**
   * Count today's accepted (non-failed) delivery attempts from the DB.
   *
   * Joins delivery_history → notifications to scope by userId.
   * channel=null counts across all channels.
   *
   * "Today" is defined as the UTC calendar day.
   */
  private async countTodayDeliveriesFromDb(
    userId: string,
    channel: DeliveryChannel | null,
  ): Promise<number> {
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const qb = this.deliveryHistoryRepository
        .createQueryBuilder('dh')
        .innerJoin(
          Notification,
          'n',
          'n.id = dh.notificationId AND n.userId = :userId',
          { userId },
        )
        .where('dh.createdAt >= :startOfDay', { startOfDay })
        .andWhere("dh.status NOT IN ('failed', 'permanent_failure')");

      if (channel !== null) {
        qb.andWhere('dh.channel = :channel', { channel });
      }

      return qb.getCount();
    } catch (err) {
      this.logger.error(
        `DB fallback count failed for user ${userId}: ${(err as Error).message}`,
      );
      // Fail-closed: treat as over cap.
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /**
   * Update user preferences using an explicit allow-list.
   *
   * Never assigns caller-provided `webhookConfig`: a signing secret can only
   * be changed through the dedicated webhook configuration service, and
   * unrelated updates preserve the existing encrypted secret.
   */
  async updatePreferences(
    userId: string,
    updates: Partial<NotificationPreference>,
  ): Promise<NotificationPreference> {
    const pref = await this.getPreferences(userId);
    if (updates && typeof updates === 'object') {
      for (const field of UPDATABLE_PREFERENCE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          (pref as unknown as Record<string, unknown>)[field] = (
            updates as unknown as Record<string, unknown>
          )[field];
        }
      }
    }
    pref.channels = normalizeChannelPreferences(pref.channels);
    pref.lastModifiedAt = new Date();
    return this.preferenceRepository.save(pref);
  }

  /**
   * Check all constraints for delivery.
   * Returns { allowed, reason, resetAt } to aid delivery orchestration.
   * resetAt is populated when a quota cap is the reason for denial.
   */
  async shouldDeliver(
    userId: string,
    eventType: EventType,
    channel: DeliveryChannel,
  ): Promise<{ allowed: boolean; reason?: string; resetAt?: string }> {
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

    // Check rate limits (atomic quota reservation)
    const quota = await this.canDeliverNotification(userId, channel);
    if (!quota.allowed) {
      return {
        allowed: false,
        reason: quota.reason === 'email_cap_reached'
          ? `Daily email limit reached for ${channel}`
          : `Daily limit reached for ${channel}`,
        resetAt: quota.resetAt,
      };
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
