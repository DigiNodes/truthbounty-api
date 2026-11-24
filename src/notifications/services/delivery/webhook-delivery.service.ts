import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../interfaces/notification.types';
import { narrowDeliveryError } from '../../delivery/delivery-error';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

@Injectable()
export class WebhookDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(WebhookDeliveryService.name);
  readonly channel = DeliveryChannel.WEBHOOK;

  async deliver(payload: RenderedNotificationPayload): Promise<DeliveryResult> {
    const webhookUrl = this.resolveDestination(payload);
    if (!webhookUrl) {
      return { success: false, failureReason: 'No webhook URL configured' };
    }

    try {
      this.logger.debug(
        `Webhook delivery for notification ${payload.notificationId ?? 'unknown'}`,
      );

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TruthBounty-Notification/1.0',
        },
        body: JSON.stringify({
          notificationId: payload.notificationId,
          type: payload.eventType,
          title: payload.rendered.title,
          body: payload.rendered.body,
          data: payload.metadata,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        // Narrow the provider status before reading it back.
        const narrowed = narrowDeliveryError(
          {
            statusCode: response.status,
            message: `Webhook returned ${response.status}`,
          },
          { channel: this.channel },
        );
        return {
          success: false,
          failureReason: narrowed.message,
          responseData: {
            statusCode: response.status,
            kind: narrowed.kind,
            retryable: narrowed.retryable,
          },
        };
      }

      return {
        success: true,
        deliveredAt: new Date(),
        responseData: { statusCode: response.status },
      };
    } catch (error) {
      this.logger.error(
        `Webhook delivery failed for notification ${payload.notificationId ?? 'unknown'}`,
      );
      return this.failure(error);
    }
  }
}
