import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../enums/notification-type.enum';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';

@Injectable()
export class SmsDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(SmsDeliveryService.name);
  readonly channel = DeliveryChannel.SMS;

  async deliver(delivery: NotificationDelivery): Promise<DeliveryResult> {
    const phoneNumber = delivery.destination;
    if (!phoneNumber) {
      return { success: false, failureReason: 'No phone number configured' };
    }

    try {
      this.logger.debug(`SMS delivery to ${phoneNumber} for notification ${delivery.notificationId}`);

      this.logger.log(
        `SMS TO: ${phoneNumber} | Body: ${delivery.responseData?.body || ''}`,
      );

      return {
        success: true,
        deliveredAt: new Date(),
        responseData: { provider: 'twilio-placeholder', phoneNumber },
      };
    } catch (error) {
      this.logger.error(`SMS delivery failed to ${phoneNumber}: ${error.message}`);
      return {
        success: false,
        failureReason: error.message,
      };
    }
  }
}
