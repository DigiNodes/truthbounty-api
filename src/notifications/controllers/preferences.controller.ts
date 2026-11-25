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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { WebhookPreferencesService } from '../services/webhook-preferences.service';
import { NotificationPreference } from '../entities/notification-preference.entity';
import {
  ConfigureWebhookDto,
  RotateWebhookSecretDto,
} from '../dto/configure-webhook.dto';
import { PatchPreferencesDto } from '../dto/patch-preferences.dto';
import {
  NotificationPreferenceResponseDto,
  toNotificationPreferenceResponse,
} from '../dto/preferences-response.dto';
import { requireDeliveryChannel } from '../delivery/delivery-channel';
import { UpdatePreferenceSettingsDto } from '../dto/update-preference-settings.dto';

@ApiTags('Notifications - Preferences')
@Controller('api/v2/notifications/preferences')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PreferencesController {
  private readonly logger = new Logger(PreferencesController.name);

  constructor(
    private preferenceEnforcer: PreferenceEnforcer,
    private webhookPreferences: WebhookPreferencesService,
  ) {}

  /**
   * Get user notification preferences. Webhook secrets are never returned.
   */
  @Get()
  @ApiOperation({ summary: 'Get notification preferences' })
  @ApiResponse({
    status: 200,
    description: 'User preferences (webhook secrets are redacted)',
    type: NotificationPreferenceResponseDto,
  })
  async getPreferences(
    @CurrentUser('id') userId: string,
  ): Promise<NotificationPreferenceResponseDto> {
    this.logger.debug(`Fetching preferences for user ${userId}`);
    const preferences = await this.preferenceEnforcer.getPreferences(userId);
    return toNotificationPreferenceResponse(preferences);
  }

  /**
   * Update notification preferences. Only allow-listed fields are accepted;
   * webhook secrets can only be changed through the dedicated webhook routes.
   */
  @Patch()
  @ApiOperation({ summary: 'Update notification preferences' })
  @ApiResponse({
    status: 200,
    description: 'Updated preferences (webhook secrets are redacted)',
    type: NotificationPreferenceResponseDto,
  })
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() updates: UpdatePreferenceSettingsDto,
  ): Promise<NotificationPreference> {
    this.logger.debug(`Updating preferences for user ${userId}`, updates);
    return this.preferenceEnforcer.updatePreferences(userId, updates);
  }

  /**
   * Enable a channel
   */
  @Post('channels/:channel/enable')
  @ApiOperation({ summary: 'Enable notification channel' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async enableChannel(
    @CurrentUser('id') userId: string,
    @Param('channel') rawChannel: string,
  ): Promise<NotificationPreferenceResponseDto> {
    const channel = requireDeliveryChannel(rawChannel);
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.channels[channel] = true;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Disable a channel
   */
  @Post('channels/:channel/disable')
  @ApiOperation({ summary: 'Disable notification channel' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async disableChannel(
    @CurrentUser('id') userId: string,
    @Param('channel') rawChannel: string,
  ): Promise<NotificationPreferenceResponseDto> {
    const channel = requireDeliveryChannel(rawChannel);
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.channels[channel] = false;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Configure quiet hours
   */
  @Post('quiet-hours')
  @ApiOperation({ summary: 'Configure quiet hours' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async setQuietHours(
    @CurrentUser('id') userId: string,
    @Body() quietHoursConfig: { enabled: boolean; startTime?: string; endTime?: string; timezone?: string },
  ): Promise<NotificationPreferenceResponseDto> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.quietHours = quietHoursConfig;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Disable quiet hours
   */
  @Delete('quiet-hours')
  @ApiOperation({ summary: 'Disable quiet hours' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async disableQuietHours(
    @CurrentUser('id') userId: string,
  ): Promise<NotificationPreferenceResponseDto> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.quietHours = { enabled: false };
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Configure digest preferences
   */
  @Post('digest')
  @ApiOperation({ summary: 'Configure digest mode' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async setDigestPreferences(
    @CurrentUser('id') userId: string,
    @Body() digestConfig: { enabled: boolean; frequency?: 'DAILY' | 'WEEKLY'; deliveryTime?: string },
  ): Promise<NotificationPreferenceResponseDto> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.digestPreferences = digestConfig;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Update email address
   */
  @Patch('email')
  @ApiOperation({ summary: 'Update notification email' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async updateEmail(
    @CurrentUser('id') userId: string,
    @Body() { email }: { email: string },
  ): Promise<NotificationPreferenceResponseDto> {
    // TODO: Verify email before setting
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    prefs.emailAddress = email;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Configure webhook. The signing secret is write-only: it is encrypted at
   * rest and is never included in the response.
   */
  @Post('webhook')
  @ApiOperation({ summary: 'Configure webhook (signing secret is write-only)' })
  @ApiResponse({
    status: 201,
    description: 'Webhook metadata with secretConfigured indicator',
    type: NotificationPreferenceResponseDto,
  })
  async setWebhook(
    @CurrentUser('id') userId: string,
    @Body() webhookConfig: ConfigureWebhookDto,
  ): Promise<NotificationPreferenceResponseDto> {
    const saved = await this.webhookPreferences.configureWebhook(userId, webhookConfig);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Explicitly rotate the webhook signing secret. The previous value is
   * invalidated immediately and only safe metadata is returned.
   */
  @Post('webhook/secret/rotate')
  @ApiOperation({ summary: 'Rotate webhook signing secret (write-only)' })
  @ApiResponse({ status: 201, type: NotificationPreferenceResponseDto })
  async rotateWebhookSecret(
    @CurrentUser('id') userId: string,
    @Body() input: RotateWebhookSecretDto,
  ): Promise<NotificationPreferenceResponseDto> {
    const saved = await this.webhookPreferences.rotateSecret(userId, input);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Remove webhook
   */
  @Delete('webhook')
  @ApiOperation({ summary: 'Remove webhook' })
  @ApiResponse({ status: 200, type: NotificationPreferenceResponseDto })
  async removeWebhook(
    @CurrentUser('id') userId: string,
  ): Promise<NotificationPreferenceResponseDto> {
    const saved = await this.webhookPreferences.removeWebhook(userId);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Subscribe to event category
   */
  @Post('subscribe/:eventType')
  @ApiOperation({ summary: 'Subscribe to event type' })
  @ApiResponse({ status: 201, type: NotificationPreferenceResponseDto })
  async subscribeToEvent(
    @CurrentUser('id') userId: string,
    @Param('eventType') eventType: string,
  ): Promise<NotificationPreferenceResponseDto> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    if (!prefs.categorySubscriptions) {
      prefs.categorySubscriptions = {};
    }
    prefs.categorySubscriptions[eventType] = true;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }

  /**
   * Unsubscribe from event category
   */
  @Post('unsubscribe/:eventType')
  @ApiOperation({ summary: 'Unsubscribe from event type' })
  @ApiResponse({ status: 201, type: NotificationPreferenceResponseDto })
  async unsubscribeFromEvent(
    @CurrentUser('id') userId: string,
    @Param('eventType') eventType: string,
  ): Promise<NotificationPreferenceResponseDto> {
    const prefs = await this.preferenceEnforcer.getPreferences(userId);
    if (!prefs.categorySubscriptions) {
      prefs.categorySubscriptions = {};
    }
    prefs.categorySubscriptions[eventType] = false;
    const saved = await this.preferenceEnforcer.updatePreferences(userId, prefs);
    return toNotificationPreferenceResponse(saved);
  }
}
