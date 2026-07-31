import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../enums/notification-type.enum';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';

@Injectable()
export class WebhookDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(WebhookDeliveryService.name);
  readonly channel = DeliveryChannel.WEBHOOK;

  async deliver(delivery: NotificationDelivery): Promise<DeliveryResult> {
    const webhookUrl = delivery.destination;
    if (!webhookUrl) {
      return { success: false, failureReason: 'No webhook URL configured' };
    }

    try {
      this.logger.debug(`Webhook delivery to ${webhookUrl} for notification ${delivery.notificationId}`);

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TruthBounty-Notification/1.0',
        },
        body: JSON.stringify({
          notificationId: delivery.notificationId,
          type: delivery.responseData?.type,
          title: delivery.responseData?.title,
          body: delivery.responseData?.body,
          data: delivery.responseData?.data,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => 'unknown');
        return {
          success: false,
          failureReason: `Webhook returned ${response.status}: ${responseText}`,
          responseData: { statusCode: response.status, body: responseText },
        };
      }

      const responseBody = await response.text().catch(() => '');
      return {
        success: true,
        deliveredAt: new Date(),
        responseData: { statusCode: response.status, body: responseBody },
      };
    } catch (error) {
      this.logger.error(`Webhook delivery failed to ${webhookUrl}: ${error.message}`);
      return {
        success: false,
        failureReason: error.message,
      };
    }
  }
}
