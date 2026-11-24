import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ChannelPreferences,
  NotificationPreference,
} from '../entities/notification-preference.entity';

/**
 * Safe view of a stored webhook configuration.
 *
 * The signing secret is deliberately absent: clients can learn whether a
 * secret is configured, but never the value itself (PREWAVE-BE-169).
 */
export class WebhookConfigResponseDto {
  @ApiProperty({ description: 'Webhook destination URL' })
  url: string;

  @ApiPropertyOptional({ type: [String], description: 'Subscribed event types' })
  events?: string[];

  @ApiProperty({
    description: 'Whether a signing secret is configured (the value is never returned)',
    example: false,
  })
  secretConfigured: boolean;

  @ApiPropertyOptional({ description: 'Configured retry attempts' })
  retryAttempts?: number;

  @ApiPropertyOptional({ description: 'Request timeout in milliseconds' })
  timeout?: number;
}

/**
 * Response contract for all notification preference endpoints.
 *
 * Built by an explicit allow-list in `toNotificationPreferenceResponse`;
 * internal fields such as `webhookConfig.secret` and `unsubscribeToken` are
 * intentionally excluded.
 */
export class NotificationPreferenceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiProperty({ type: Object })
  channels: ChannelPreferences;

  @ApiPropertyOptional({ type: Object })
  categorySubscriptions?: Record<string, boolean>;

  @ApiPropertyOptional({ type: Object })
  quietHours?: { enabled: boolean; startTime?: string; endTime?: string; timezone?: string };

  @ApiPropertyOptional({ type: Object })
  digestPreferences?: { enabled: boolean; frequency?: 'DAILY' | 'WEEKLY'; deliveryTime?: string };

  @ApiProperty()
  language: string;

  @ApiPropertyOptional()
  maxNotificationsPerDay?: number;

  @ApiPropertyOptional()
  maxEmailsPerDay?: number;

  @ApiPropertyOptional()
  emailAddress?: string;

  @ApiPropertyOptional({
    type: WebhookConfigResponseDto,
    nullable: true,
    description: 'Webhook metadata. The signing secret is never included.',
  })
  webhookConfig?: WebhookConfigResponseDto | null;

  @ApiPropertyOptional({ type: Object })
  pushConfig?: { enabled: boolean; deviceTokens?: string[] };

  @ApiPropertyOptional()
  lastModifiedAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/**
 * Convert a preference entity into the public response contract.
 *
 * This is an explicit allow-list: adding a field to the entity never
 * automatically exposes it through the API.
 */
export function toNotificationPreferenceResponse(
  preference: NotificationPreference,
): NotificationPreferenceResponseDto {
  const webhook = preference.webhookConfig;

  return {
    id: preference.id,
    userId: preference.userId,
    channels: preference.channels,
    categorySubscriptions: preference.categorySubscriptions,
    quietHours: preference.quietHours,
    digestPreferences: preference.digestPreferences,
    language: preference.language,
    maxNotificationsPerDay: preference.maxNotificationsPerDay,
    maxEmailsPerDay: preference.maxEmailsPerDay,
    emailAddress: preference.emailAddress,
    webhookConfig: webhook
      ? {
          url: webhook.url,
          events: webhook.events ? [...webhook.events] : undefined,
          secretConfigured: Boolean(webhook.secret),
          retryAttempts: webhook.retryAttempts,
          timeout: webhook.timeout,
        }
      : null,
    pushConfig: preference.pushConfig,
    lastModifiedAt: preference.lastModifiedAt,
    createdAt: preference.createdAt,
    updatedAt: preference.updatedAt,
  };
}

/**
 * Safe metadata for audit records. Never contains the raw or encrypted secret.
 */
export function toWebhookAuditMetadata(
  preference: NotificationPreference,
): Record<string, unknown> {
  const webhook = preference.webhookConfig;
  return {
    urlConfigured: Boolean(webhook?.url),
    eventCount: webhook?.events?.length ?? 0,
    secretConfigured: Boolean(webhook?.secret),
  };
}
