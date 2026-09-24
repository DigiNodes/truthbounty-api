import { Logger } from '@nestjs/common';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';
import { DeliveryStatus, DeliveryChannel } from '../../enums/notification-type.enum';

export interface DeliveryResult {
  success: boolean;
  deliveredAt?: Date;
  failureReason?: string;
  responseData?: Record<string, any>;
}

export abstract class BaseDeliveryService {
  protected abstract readonly logger: Logger;

  abstract get channel(): DeliveryChannel;

  abstract deliver(
    delivery: NotificationDelivery,
  ): Promise<DeliveryResult>;

  protected updateDeliveryStatus(
    delivery: NotificationDelivery,
    status: DeliveryStatus,
    extra?: Partial<NotificationDelivery>,
  ): NotificationDelivery {
    Object.assign(delivery, {
      status,
      ...extra,
    });
    return delivery;
  }
}
