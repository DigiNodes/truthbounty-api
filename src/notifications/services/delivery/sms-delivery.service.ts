import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../interfaces/notification.types';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

@Injectable()
export class SmsDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(SmsDeliveryService.name);
  readonly channel = DeliveryChannel.SMS;

  deliver(payload: RenderedNotificationPayload): Promise<DeliveryResult> {
    const phoneNumber = this.resolveDestination(payload);
    if (!phoneNumber) {
      return Promise.resolve({
        success: false,
        failureReason: 'No phone number configured',
      });
    }

    try {
      this.logger.debug(
        `SMS delivery for notification ${payload.notificationId ?? 'unknown'}`,
      );

      return Promise.resolve({
        success: true,
        deliveredAt: new Date(),
        responseData: { provider: 'twilio-placeholder' },
      });
    } catch (error) {
      this.logger.error(
        `SMS delivery failed for notification ${payload.notificationId ?? 'unknown'}`,
      );
      return Promise.resolve(this.failure(error));
    }
  }
}
