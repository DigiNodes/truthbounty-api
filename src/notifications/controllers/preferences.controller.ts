import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryChannel } from '../interfaces/notification.types';

@ApiTags('Notifications - Preferences')
@Controller('api/v2/notifications/preferences')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PreferencesController {
  private readonly logger = new Logger(PreferencesController.name);

  constructor(private preferenceEnforcer: PreferenceEnforcer) {}

  /**
   * Get user notification preferences
   */
  @Get()
  @ApiOperation({ summary: 'Get notification preferences' })
  @ApiResponse({
    status: 200,
    description: 'User preferences',
    type: NotificationPreference,
  })
  async getPreferences(@CurrentUser('id') userId: string): Promise<NotificationPreference> {
    this.logger.debug(`Fetching preferences for user ${userId}`);
    return this.preferenceEnforcer.getPreferences(userId);
  }

  /**
   * Update notification preferences
   */
  @Patch()
  @ApiOperation({ summary: 'Update notification preferences' })
  @ApiResponse({
    status: 200,
    description: 'Updated preferences',
    type: NotificationPreference,
  })
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() updates: Partial<NotificationPreference>,
  ): Promise<NotificationPreference> {
    this.logger.debug(`Updating preferences for user ${userId}`, updates);
    return this.preferenceEnforcer.updatePreferences(userId, updates);
  }

  /**
   * Enable a channel
   */
  @Post('channels/:channel/enable')
  @ApiOperation({ summary: 'Enable notification channel' })
  async enableChannel(
    @CurrentUser('id') userId: string,
    @Param('channel') channel: DeliveryChannel,
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.channels[channel] = true;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Disable a channel
   */
  @Post('channels/:channel/disable')
  @ApiOperation({ summary: 'Disable notification channel' })
  async disableChannel(
    @CurrentUser('id') userId: string,
    @Param('channel') channel: DeliveryChannel,
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.channels[channel] = false;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Configure quiet hours
   */
  @Post('quiet-hours')
  @ApiOperation({ summary: 'Configure quiet hours' })
  async setQuietHours(
    @CurrentUser('id') userId: string,
    @Body()
    quietHoursConfig: {
      enabled: boolean;
      startTime?: string; // HH:mm
      endTime?: string; // HH:mm
      timezone?: string;
    },
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.quietHours = quietHoursConfig;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Disable quiet hours
   */
  @Delete('quiet-hours')
  @ApiOperation({ summary: 'Disable quiet hours' })
  async disableQuietHours(@CurrentUser('id') userId: string): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.quietHours = { enabled: false };
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Configure digest preferences
   */
  @Post('digest')
  @ApiOperation({ summary: 'Configure digest mode' })
  async setDigestPreferences(
    @CurrentUser('id') userId: string,
    @Body()
    digestConfig: {
      enabled: boolean;
      frequency?: 'DAILY' | 'WEEKLY';
      deliveryTime?: string; // HH:mm
    },
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.digestPreferences = digestConfig;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Update email address
   */
  @Patch('email')
  @ApiOperation({ summary: 'Update notification email' })
  async updateEmail(
    @CurrentUser('id') userId: string,
    @Body() { email }: { email: string },
  ): Promise<NotificationPreference> {
    // TODO: Verify email before setting
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.emailAddress = email;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Configure webhook
   */
  @Post('webhook')
  @ApiOperation({ summary: 'Configure webhook' })
  async setWebhook(
    @CurrentUser('id') userId: string,
    @Body()
    webhookConfig: {
      url: string;
      secret?: string;
      events?: string[];
    },
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.webhookConfig = webhookConfig;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Remove webhook
   */
  @Delete('webhook')
  @ApiOperation({ summary: 'Remove webhook' })
  async removeWebhook(@CurrentUser('id') userId: string): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.webhookConfig = null;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Subscribe to event category
   */
  @Post('subscribe/:eventType')
  @ApiOperation({ summary: 'Subscribe to event type' })
  async subscribeToEvent(
    @CurrentUser('id') userId: string,
    @Param('eventType') eventType: string,
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    if (!prefs.categorySubscriptions) {
      prefs.categorySubscriptions = {};
    }
    prefs.categorySubscriptions[eventType] = true;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }

  /**
   * Unsubscribe from event category
   */
  @Post('unsubscribe/:eventType')
  @ApiOperation({ summary: 'Unsubscribe from event type' })
  async unsubscribeFromEvent(
    @CurrentUser('id') userId: string,
    @Param('eventType') eventType: string,
  ): Promise<NotificationPreference> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    if (!prefs.categorySubscriptions) {
      prefs.categorySubscriptions = {};
    }
    prefs.categorySubscriptions[eventType] = false;
    return this.preferenceEnforcer.updatePreferences(userId, prefs);
  }
}
