import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel as ChannelType, Notification } from '../entities/notification.entity';
import { UserNotificationPreferences } from '../entities/notification.entity';
import { NotificationChannel, ChannelDeliveryResult } from './channel.interface';
import { createHmac } from 'crypto';

@Injectable()
export class WebhookChannel implements NotificationChannel {
  private readonly logger = new Logger(WebhookChannel.name);
  readonly channelType = ChannelType.WEBHOOK;

  constructor(
    @InjectRepository(UserNotificationPreferences)
    private readonly preferencesRepository: Repository<UserNotificationPreferences>,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });
    
    if (!preferences || !preferences.webhookConfig) {
      return false;
    }
    
    return preferences.enabledChannels[this.channelType] ?? false && preferences.webhookConfig.enabled;
  }

  async send(notification: Notification): Promise<ChannelDeliveryResult> {
    const preferences = await this.preferencesRepository.findOne({
      where: { userId: notification.recipientId },
    });

    if (!preferences?.webhookConfig?.url) {
      return {
        success: false,
        error: 'Webhook URL not configured',
      };
    }

    const { url, secret } = preferences.webhookConfig;
    this.logger.debug(
      `Sending webhook notification ${notification.id} to ${url}`,
    );

    try {
      // Create payload
      const payload = JSON.stringify({
        notificationId: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        metadata: notification.metadata,
        timestamp: new Date().toISOString(),
      });

      // Generate signature for verification
      const signature = this.generateSignature(payload, secret);

      // In a real implementation, this would make an HTTP POST request to the webhook URL
      // fetch(url, {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'X-Signature': signature,
      //   },
      //   body: payload,
      // });

      this.logger.debug(`Webhook payload would be sent to ${url} with signature ${signature}`);

      return {
        success: true,
        deliveryTimestamp: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to deliver webhook: ${error.message}`,
      };
    }
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

    if (!preferences.webhookConfig) {
      errors.push('Webhook not configured');
      return { valid: false, errors };
    }

    if (!preferences.webhookConfig.url) {
      errors.push('Webhook URL not provided');
    }

    if (!preferences.webhookConfig.secret) {
      errors.push('Webhook secret not provided');
    }

    if (!preferences.webhookConfig.enabled) {
      errors.push('Webhook is disabled');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private generateSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }
}