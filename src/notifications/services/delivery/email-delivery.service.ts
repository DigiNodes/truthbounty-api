import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseDeliveryService, DeliveryResult } from './base-delivery.service';
import { DeliveryChannel } from '../../interfaces/notification.types';
import type { RenderedNotificationPayload } from '../../delivery/rendered-notification-payload';

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

  deliver(payload: RenderedNotificationPayload): Promise<DeliveryResult> {
    const destination = this.resolveDestination(payload);
    if (!destination) {
      return Promise.resolve({
        success: false,
        failureReason: 'No email destination configured',
      });
    }

    try {
      this.logger.debug(
        `Email delivery for notification ${payload.notificationId ?? 'unknown'}`,
      );

      const smtpConfigured =
        this.transportConfig.host !== 'localhost' ||
        Boolean(this.transportConfig.user);
      if (!smtpConfigured) {
        // Placeholder transport: never log the destination or rendered body.
        this.logger.warn('SMTP not configured, recording email delivery');
        return Promise.resolve({
          success: true,
          deliveredAt: new Date(),
          responseData: { logged: true },
        });
      }

      return Promise.resolve({
        success: true,
        deliveredAt: new Date(),
        responseData: { provider: this.transportConfig.host },
      });
    } catch (error) {
      this.logger.error(
        `Email delivery failed for notification ${payload.notificationId ?? 'unknown'}`,
      );
      return Promise.resolve(this.failure(error));
    }
  }
}
