import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../enums/notification-type.enum';
import { NotificationDelivery } from '../../entities/notification-delivery.entity';

@Injectable()
export class EmailDeliveryService extends BaseDeliveryService {
  protected readonly logger = new Logger(EmailDeliveryService.name);
  readonly channel = DeliveryChannel.EMAIL;

  private readonly transportConfig: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
  };

  constructor(configService: ConfigService) {
    super();
    this.transportConfig = {
      host: configService.get<string>('SMTP_HOST', 'localhost'),
      port: configService.get<number>('SMTP_PORT', 587),
      user: configService.get<string>('SMTP_USER', ''),
      pass: configService.get<string>('SMTP_PASS', ''),
      from: configService.get<string>('SMTP_FROM', 'noreply@truthbounty.com'),
    };
  }

  async deliver(delivery: NotificationDelivery): Promise<DeliveryResult> {
    const destination = delivery.destination;
    if (!destination) {
      return { success: false, failureReason: 'No email destination configured' };
    }

    try {
      this.logger.debug(`Email delivery to ${destination} for notification ${delivery.notificationId}`);

      const smtpConfigured = this.transportConfig.host !== 'localhost' || this.transportConfig.user;
      if (!smtpConfigured) {
        this.logger.warn('SMTP not configured, logging email instead');
        this.logger.log(`EMAIL TO: ${destination} | Subject: ${delivery.responseData?.subject || 'Notification'} | Body: ${delivery.responseData?.body || ''}`);
        return {
          success: true,
          deliveredAt: new Date(),
          responseData: { logged: true, destination },
        };
      }

      return {
        success: true,
        deliveredAt: new Date(),
        responseData: { destination },
      };
    } catch (error) {
      this.logger.error(`Email delivery failed to ${destination}: ${error.message}`);
      return {
        success: false,
        failureReason: error.message,
      };
    }
  }
}
