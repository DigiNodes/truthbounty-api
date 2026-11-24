import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../interfaces/notification.types';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

@Injectable()
export class PushDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(PushDeliveryService.name);
  readonly channel = DeliveryChannel.PUSH;

  deliver(payload: RenderedNotificationPayload): Promise<DeliveryResult> {
    const pushToken = this.resolveDestination(payload);
    if (!pushToken) {
      return Promise.resolve({
        success: false,
        failureReason: 'No push token configured',
      });
    }

    try {
      // Only an opaque token prefix is ever logged.
      this.logger.debug(
        `Push delivery to token ${pushToken.substring(0, 8)}... for notification ${payload.notificationId ?? 'unknown'}`,
      );

      return Promise.resolve({
        success: true,
        deliveredAt: new Date(),
        responseData: {
          provider: 'fcm-placeholder',
          tokenPrefix: pushToken.substring(0, 8),
        },
      });
    } catch (error) {
      this.logger.error(
        `Push delivery failed for notification ${payload.notificationId ?? 'unknown'}`,
      );
      return Promise.resolve(this.failure(error));
    }
  }
}
