import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel as ChannelType, Notification } from '../entities/notification.entity';
import { UserNotificationPreferences } from '../entities/notification.entity';
import { NotificationChannel, ChannelDeliveryResult } from './channel.interface';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailChannel implements NotificationChannel {
  private readonly logger = new Logger(EmailChannel.name);
  readonly channelType = ChannelType.EMAIL;

  constructor(
    @InjectRepository(UserNotificationPreferences)
    private readonly preferencesRepository: Repository<UserNotificationPreferences>,
    private readonly configService: ConfigService,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });
    
    if (!preferences) {
      return false; // Default to disabled if no email configured
    }
    
    return preferences.enabledChannels[this.channelType] ?? false && preferences.emailEnabled;
  }

  async send(notification: Notification): Promise<ChannelDeliveryResult> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId: notification.recipientId },
    });

    if (!preferences || !preferences.emailAddress) {
      return {
        success: false,
        error: 'No email address configured for user',
      };
    }

    this.logger.debug(
      `Sending email notification ${notification.id} to ${preferences.emailAddress}`,
    );

    // In a real implementation, this would integrate with an email service like SendGrid, AWS SES, etc.
    // For now, we'll just log that the email would be sent
    
    const emailHtml = this.generateEmailHtml(notification);
    this.logger.debug(`Email content would be: ${emailHtml.substring(0, 200)}...`);

    return {
      success: true,
      deliveryTimestamp: new Date(),
    };
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      errors.push('No user preferences found');
      return { valid: false, errors };
    }

    if (!preferences.emailAddress) {
      errors.push('No email address configured');
    }

    if (!preferences.emailEnabled) {
      errors.push('Email notifications are disabled');
    }

    const smtpHost = this.configService.get('SMTP_HOST');
    if (!smtpHost) {
      errors.push('SMTP server not configured');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private generateEmailHtml(notification: Notification): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${notification.title}</title>
        </head>
        <body>
          <h1>${notification.title}</h1>
          <p>${notification.message}</p>
          ${notification.metadata ? `<pre>${JSON.stringify(notification.metadata, null, 2)}</pre>` : ''}
        </body>
      </html>
    `;
  }
}