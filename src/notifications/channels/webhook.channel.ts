import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import * as http from 'http';
import * as https from 'https';
import type { LookupFunction } from 'net';
import {
  NotificationChannel,
  ChannelDeliveryResult,
  RenderedNotificationPayload,
} from './channel.interface';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { DeliveryChannel } from '../interfaces/notification.types';
import { narrowDeliveryError } from '../delivery/delivery-error';
import {
  validateWebhookDestination,
  createValidatingDnsLookup,
  DEFAULT_WEBHOOK_PORTS,
  type WebhookUrlOptions,
} from '../delivery/webhook-ssrf.guard';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import * as crypto from 'crypto';

/**
 * WebhookChannel
 *
 * Delivers notifications via HTTP POST to user-configured webhooks.
 *
 * SSRF protection (see `src/notifications/delivery/webhook-ssrf.guard.ts`):
 * - Destination policy (public IPs only, no loopback/private/link-local/
 *   multicast/reserved/metadata) is enforced at delivery time, not just save
 *   time, because DNS records change.
 * - A validating DNS lookup is installed on the request agent so the *exact*
 *   addresses the socket connects to are validated at connection time. This
 *   closes the DNS-rebinding window between resolve and dial.
 * - Redirects are disabled (`maxRedirects: 0`) and 3xx responses are rejected.
 *   The HMAC signature header is therefore never forwarded to a host the
 *   destination policy never approved.
 * - Response size and timeouts are bounded.
 * - Event filtering per webhook.
 *
 * Features:
 * - HTTPS validation (production only)
 * - HMAC-SHA256 signature verification
 * - Retry on network failures
 * - Configurable timeout
 * - Event filtering per webhook
 * - Failed webhook tracking
 */
@Injectable()
export class WebhookChannel implements NotificationChannel {
  readonly channelType: DeliveryChannel = DeliveryChannel.WEBHOOK;
  private readonly logger = new Logger(WebhookChannel.name);

  private readonly webhookTimeout: number;
  private readonly requireHttps: boolean;
  private readonly maxResponseBytes: number;
  private readonly allowedPorts: readonly number[];

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private preferenceEnforcer: PreferenceEnforcer,
  ) {
    this.webhookTimeout = this.configService.get<number>(
      'WEBHOOK_TIMEOUT_MS',
      5000,
    );
    this.requireHttps = this.configService.get<boolean>(
      'WEBHOOK_REQUIRE_HTTPS',
      true,
    );
    // Bound the response body so a malicious receiver cannot exhaust memory
    // via an unbounded (possibly decompressed) stream. axios `maxContentLength`
    // is checked against the decompressed content length in the http adapter.
    this.maxResponseBytes = this.configService.get<number>(
      'WEBHOOK_MAX_RESPONSE_BYTES',
      256 * 1024, // 256 KiB
    );
    const configuredPorts = this.configService.get<string>(
      'WEBHOOK_ALLOWED_PORTS',
    );
    this.allowedPorts = configuredPorts
      ? configuredPorts
          .split(',')
          .map((p) => Number.parseInt(p.trim(), 10))
          .filter((p) => Number.isFinite(p))
      : DEFAULT_WEBHOOK_PORTS;
  }

  /**
   * Build the shared SSRF validation options from channel configuration.
   * Exposed so tests and callers use the same option set.
   */
  private ssrfOptions(): WebhookUrlOptions {
    return {
      requireHttps: this.requireHttps,
      allowedPorts: this.allowedPorts,
    };
  }

  async isEnabled(userId: string): Promise<boolean> {
    return this.preferenceEnforcer.isChannelEnabled(userId, 'WEBHOOK');
  }

  async send(
    payload: RenderedNotificationPayload,
  ): Promise<ChannelDeliveryResult> {
    try {
      const preferences = await this.preferenceEnforcer.getPreferences(
        payload.userId,
      );

      if (!preferences.webhookConfig?.url) {
        return {
          success: false,
          error: 'User has no webhook configured',
        };
      }

      const webhookUrl = preferences.webhookConfig.url;

      // Check event filtering
      if (
        preferences.webhookConfig.events &&
        !preferences.webhookConfig.events.includes(payload.eventType)
      ) {
        this.logger.debug(
          `Event ${payload.eventType} not in webhook event filter for ${payload.userId}`,
        );
        return { success: true, deliveryTimestamp: new Date() };
      }

      // Re-validate the destination at delivery time. DNS records and redirect
      // behavior can change between save and delivery, so the policy is applied
      // here as well as when the webhook is configured. The per-address DNS
      // lookup installed on the agent below is the authoritative rebinding guard.
      const destination = await validateWebhookDestination(
        webhookUrl,
        this.ssrfOptions(),
      );
      if (!destination.valid) {
        this.logger.warn(
          `Webhook destination rejected for user ${payload.userId}: ${destination.error}`,
        );
        return {
          success: false,
          error: 'Invalid webhook destination',
        };
      }

      // Build webhook payload (kept minimal; no secrets or unnecessary PII).
      const webhookPayload = {
        event: payload.eventType,
        timestamp: new Date().toISOString(),
        userId: payload.userId,
        notification: {
          title: payload.rendered.title,
          subject: payload.rendered.subject,
          body: payload.rendered.body,
          html: payload.rendered.html,
          actionUrl: payload.rendered.actionUrl,
        },
        metadata: payload.metadata,
      };

      // Generate HMAC signature if secret provided
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'TruthBounty-NotificationService/1.0',
      };

      if (preferences.webhookConfig.secret) {
        const signature = crypto
          .createHmac('sha256', preferences.webhookConfig.secret)
          .update(JSON.stringify(webhookPayload))
          .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      // Install a validating DNS lookup on a fresh, non-pooled agent so the
      // socket only ever connects to validated addresses. The lookup validates
      // at connection time, defeating DNS rebinding. A fresh agent per request
      // also prevents a poisoned pooled connection from being reused.
      //
      // The guard's lookup is structurally a Node `LookupFunction` but is
      // typed permissively (callback receives `string | LookupAddress[] | null`
      // on the error path) for test ergonomics; assert it to the agent's
      // expected `LookupFunction` at this single integration point.
      const isHttps = webhookUrl.toLowerCase().startsWith('https://');
      const validatingLookup =
        createValidatingDnsLookup() as unknown as LookupFunction;
      const agent = isHttps
        ? new https.Agent({ lookup: validatingLookup, keepAlive: false })
        : new http.Agent({ lookup: validatingLookup, keepAlive: false });

      const webhookTimeout =
        preferences.webhookConfig.timeout || this.webhookTimeout;

      // Send webhook. Redirects are disabled (`maxRedirects: 0`); any 3xx is
      // rejected below. This guarantees the signature header is never forwarded
      // to a host the destination policy did not approve. Response size and the
      // overall request are bounded.
      const response = await firstValueFrom(
        this.httpService
          .post(webhookUrl, webhookPayload, {
            headers,
            maxRedirects: 0,
            maxContentLength: this.maxResponseBytes,
            maxBodyLength: this.maxResponseBytes,
            timeout: webhookTimeout,
            ...(isHttps ? { httpsAgent: agent } : { httpAgent: agent }),
          })
          .pipe(timeout(webhookTimeout)),
      );

      // Reject redirects. Because maxRedirects is 0 the signature was sent only
      // to the validated destination; we must not follow the Location target.
      if (response.status >= 300 && response.status < 400) {
        this.logger.warn(
          `Webhook returned a redirect (${response.status}); redirects are not allowed`,
        );
        return {
          success: false,
          error:
            'Webhook destination attempted a redirect, which is not allowed',
        };
      }

      this.logger.debug(
        `Webhook sent to ${webhookUrl} for ${payload.userId} (status: ${response.status})`,
      );

      return {
        success: true,
        deliveryTimestamp: new Date(),
        channelMessageId: `webhook-${Date.now()}`,
      };
    } catch (error) {
      // Narrow before reading any provider-specific field. Never log the
      // webhook URL or body, which may contain secrets.
      const narrowed = narrowDeliveryError(error, {
        channel: DeliveryChannel.WEBHOOK,
      });

      this.logger.warn(
        `Failed to send webhook notification: ${narrowed.message} (retryable: ${narrowed.retryable})`,
      );

      return {
        success: false,
        error: narrowed.message,
      };
    }
  }

  async validateConfig(
    userId: string,
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    const preferences = await this.preferenceEnforcer.getPreferences(userId);

    if (!preferences.webhookConfig) {
      return { valid: false, errors: ['No webhook configured'] };
    }

    const { url } = preferences.webhookConfig;

    if (!url) {
      errors.push('Webhook URL is required');
    } else {
      // Full validation: structural policy + DNS resolution + per-address check.
      const result = await validateWebhookDestination(url, this.ssrfOptions());
      if (!result.valid) {
        errors.push(result.error ?? 'Invalid webhook URL');
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
