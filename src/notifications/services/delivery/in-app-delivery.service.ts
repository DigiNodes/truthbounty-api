import { Injectable, Logger } from '@nestjs/common';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel, DeliveryStatus } from '../../enums/notification-type.enum';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';

@Injectable()
export class InAppDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(InAppDeliveryService.name);
  readonly channel = DeliveryChannel.IN_APP;

  async deliver(delivery: NotificationDelivery): Promise<DeliveryResult> {
    try {
      this.logger.debug(`In-app delivery for notification ${delivery.notificationId}`);
      return {
        success: true,
        deliveredAt: new Date(),
        responseData: { channel: 'in-app' },
      };
    } catch (error) {
      this.logger.error(`In-app delivery failed: ${error.message}`);
      return {
        success: false,
        failureReason: error.message,
      };
    }
  }
}
