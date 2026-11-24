import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../interfaces/notification.types';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

@Injectable()
export class InAppDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(InAppDeliveryService.name);
  readonly channel = DeliveryChannel.IN_APP;

  deliver(payload: RenderedNotificationPayload): Promise<DeliveryResult> {
    try {
      this.logger.debug(
        `In-app delivery for notification ${payload.notificationId ?? 'unknown'}`,
      );
      return Promise.resolve({
        success: true,
        deliveredAt: new Date(),
        responseData: { channel: 'in-app' },
      });
    } catch (error) {
      return Promise.resolve(this.failure(error));
    }
  }
}
