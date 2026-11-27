import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel, ChannelDeliveryResult, RenderedNotificationPayload } from './channel.interface';
import { DeliveryChannel } from '../interfaces/notification.types';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { FcmConfigService } from './fcm-config.service';
import * as admin from 'firebase-admin';

/**
 * PushChannel
 * 
 * Delivers mobile push notifications via Firebase Cloud Messaging (FCM) or other providers.
 * 
 * Features:
 * - Multi-device support (user can have multiple registered devices)
 * - Device token management
 * - Retry on transient failures
 * - Deep linking support (open specific screens)
 * - Badge and sound configuration
 * - Rate limiting per device
 * 
 * TODO: Implement FCM integration
 */
@Injectable()
export class PushChannel implements NotificationChannel {
  readonly channelType: DeliveryChannel = DeliveryChannel.PUSH;
  private readonly logger = new Logger(PushChannel.name);

  private readonly fcmServerKey: string;
  private readonly fcmProjectId: string;

  constructor(
    private configService: ConfigService,
    private preferenceEnforcer: PreferenceEnforcer,
    private fcmConfig: FcmConfigService,
  ) {
    this.fcmServerKey = this.configService.get<string>('FCM_SERVER_KEY');
    this.fcmProjectId = this.configService.get<string>('FCM_PROJECT_ID');
  }

  async isEnabled(userId: string): Promise<boolean> {
    return this.preferenceEnforcer.isChannelEnabled(userId, 'PUSH' as any);
  }

  async send(payload: RenderedNotificationPayload): Promise<ChannelDeliveryResult> {
    try {
      // Fail-closed: Check FCM configuration
      const messaging = this.fcmConfig.getMessaging();
      if (!messaging) {
        return {
          success: false,
          error: 'FCM not configured',
        };
      }

      // Get user's registered device tokens
      const preferences = await this.preferenceEnforcer.getPreferences(payload.userId);

      if (!preferences.pushConfig?.deviceTokens || preferences.pushConfig.deviceTokens.length === 0) {
        return {
          success: false,
          error: 'User has no registered push devices',
        };
      }

      const deviceTokens = preferences.pushConfig.deviceTokens;

      // Build FCM multicast message
      const message: admin.messaging.MulticastMessage = {
        tokens: deviceTokens,
        notification: {
          title: payload.rendered.title || 'TruthBounty',
          body: payload.rendered.body,
        },
        data: {
          eventType: payload.eventType,
          notificationId: payload.notificationId || '',
          ...(payload.rendered.actionUrl && { actionUrl: payload.rendered.actionUrl }),
        },
        android: {
          priority: 'high',
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      // Send to all devices
      this.logger.debug(
        `Sending FCM push to ${deviceTokens.length} devices for user ${payload.userId}`
      );

      const response = await messaging.sendEachForMulticast(message);

      // Handle partial failures and identify invalid tokens
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const errorCode = resp.error.code;
          
          // Log error without exposing device token (only first 10 chars)
          this.logger.debug(
            `FCM delivery failed for device ${deviceTokens[idx].substring(0, 10)}...: ${errorCode}`
          );

          // Identify invalid/unregistered tokens for cleanup
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(deviceTokens[idx]);
          }
        }
      });

      // Clean up invalid tokens automatically
      if (invalidTokens.length > 0) {
        await this.cleanupInvalidTokens(payload.userId, invalidTokens);
      }

      // Determine overall success
      const successCount = response.successCount;
      const totalDevices = deviceTokens.length;

      if (successCount === 0) {
        // All devices failed
        return {
          success: false,
          error: `Failed to deliver to all ${totalDevices} devices`,
          metadata: {
            totalDevices,
            successCount: 0,
            failureCount: response.failureCount,
            invalidTokensCleaned: invalidTokens.length,
          },
        };
      }

      // At least one device succeeded
      return {
        success: true,
        deliveryTimestamp: new Date(),
        channelMessageId: `fcm-multicast-${Date.now()}-${successCount}/${totalDevices}`,
        metadata: {
          totalDevices,
          successCount: response.successCount,
          failureCount: response.failureCount,
          invalidTokensCleaned: invalidTokens.length,
        },
      };
    } catch (error) {
      // Log error without exposing device tokens or credentials
      this.logger.error(
        `FCM delivery failed for user ${payload.userId}: ${error.message}`,
        {
          errorCode: error.code,
          userId: payload.userId,
        }
      );

      return {
        success: false,
        error: error.message || 'FCM delivery failed',
      };
    }
  }

  /**
   * Clean up invalid/unregistered device tokens.
   * Removes tokens that FCM reports as invalid to prevent future failures.
   * 
   * Security: Logs token count but never logs full token values.
   */
  private async cleanupInvalidTokens(userId: string, invalidTokens: string[]): Promise<void> {
    try {
      const preferences = await this.preferenceEnforcer.getPreferences(userId);
      
      if (preferences.pushConfig?.deviceTokens) {
        const originalCount = preferences.pushConfig.deviceTokens.length;
        
        // Filter out invalid tokens
        preferences.pushConfig.deviceTokens = preferences.pushConfig.deviceTokens.filter(
          token => !invalidTokens.includes(token)
        );

        await this.preferenceEnforcer.updatePreferences(userId, preferences);

        const cleanedCount = invalidTokens.length;
        const remainingCount = preferences.pushConfig.deviceTokens.length;

        this.logger.log(
          `Cleaned up ${cleanedCount} invalid FCM tokens for user ${userId} ` +
          `(${remainingCount} devices remaining)`
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to cleanup invalid FCM tokens for user ${userId}: ${error.message}`,
        error.stack
      );
      // Don't throw - token cleanup is best-effort
    }
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check FCM configuration
    const fcmValidation = this.fcmConfig.validateConfig();
    if (!fcmValidation.valid) {
      errors.push(...fcmValidation.errors);
      return { valid: false, errors };
    }

    // Check user has registered devices
    const preferences = await this.preferenceEnforcer.getPreferences(userId);

    if (!preferences.pushConfig?.deviceTokens || preferences.pushConfig.deviceTokens.length === 0) {
      errors.push('No registered push devices');
    }

    // Validate token format (basic check - don't send test message)
    const deviceTokens = preferences.pushConfig?.deviceTokens || [];
    for (const token of deviceTokens) {
      if (!token || token.length < 10) {
        // Log only first 10 chars for debugging, never full token
        errors.push(`Invalid device token format: ${token.substring(0, 10)}...`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Register device token for user
   * Called when user registers from mobile client
   */
  async registerDeviceToken(userId: string, deviceToken: string): Promise<void> {
    const preferences = await this.preferenceEnforcer.getPreferences(userId);

    if (!preferences.pushConfig) {
      preferences.pushConfig = { enabled: true, deviceTokens: [] };
    }

    if (!preferences.pushConfig.deviceTokens.includes(deviceToken)) {
      preferences.pushConfig.deviceTokens.push(deviceToken);
      await this.preferenceEnforcer.updatePreferences(userId, preferences);
      this.logger.debug(`Registered push device for ${userId}`);
    }
  }

  /**
   * Unregister device token
   */
  async unregisterDeviceToken(userId: string, deviceToken: string): Promise<void> {
    const preferences = await this.preferenceEnforcer.getPreferences(userId);

    if (preferences.pushConfig?.deviceTokens) {
      preferences.pushConfig.deviceTokens = preferences.pushConfig.deviceTokens.filter(
        (token) => token !== deviceToken,
      );
      await this.preferenceEnforcer.updatePreferences(userId, preferences);
      this.logger.debug(`Unregistered push device for ${userId}`);
    }
  }
}
