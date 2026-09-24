import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../enums/notification-type.enum';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';

@Injectable()
export class PushDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(PushDeliveryService.name);
  readonly channel = DeliveryChannel.PUSH;

  async deliver(delivery: NotificationDelivery): Promise<DeliveryResult> {
    const pushToken = delivery.destination;
    if (!pushToken) {
      return { success: false, failureReason: 'No push token configured' };
    }

    try {
      this.logger.debug(`Push delivery to token ${pushToken.substring(0, 8)}... for notification ${delivery.notificationId}`);

      this.logger.log(
        `PUSH NOTIFICATION to ${pushToken.substring(0, 8)}... | ` +
        `Title: ${delivery.responseData?.title || ''} | ` +
        `Body: ${delivery.responseData?.body || ''}`,
      );

      return {
        success: true,
        deliveredAt: new Date(),
        responseData: { provider: 'fcm-placeholder', tokenPrefix: pushToken.substring(0, 8) },
      };
    } catch (error) {
      this.logger.error(`Push delivery failed: ${error.message}`);
      return {
        success: false,
        failureReason: error.message,
      };
    }
  }
}
