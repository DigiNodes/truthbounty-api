import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { NotificationService } from './services/notification.service';
import { TemplateService } from './services/template.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { Notification } from './entities/notification.entity';
import { NotificationTemplate } from './entities/notification-template.entity';
import { UserNotificationPreference } from './entities/user-notification-preference.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { NotificationType } from './enums/notification-type.enum';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly templateService: TemplateService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create and send a notification' })
  @ApiResponse({ status: 201, type: NotificationResponseDto })
  async create(@Body() dto: CreateNotificationDto): Promise<Notification> {
    return this.notificationService.create(dto);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get notifications for a user' })
  @ApiResponse({ status: 200 })
  async getUserNotifications(
    @Param('userId') userId: string,
    @Query() query: QueryNotificationsDto,
  ): Promise<{ notifications: Notification[]; total: number }> {
    return this.notificationService.getUserNotifications(userId, query);
  }

  @Get(':userId/unread-count')
  @ApiOperation({ summary: 'Get unread notification count for a user' })
  @ApiResponse({ status: 200 })
  async getUnreadCount(
    @Param('userId') userId: string,
  ): Promise<{ count: number }> {
    const count = await this.notificationService.getUnreadCount(userId);
    return { count };
  }

  @Patch(':notificationId/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiResponse({ status: 200, type: NotificationResponseDto })
  async markAsRead(
    @Param('notificationId') notificationId: string,
    @Query('userId') userId: string,
  ): Promise<Notification> {
    if (!userId) throw new BadRequestException('userId query parameter is required');
    try {
      return await this.notificationService.markAsRead(notificationId, userId);
    } catch (error) {
      throw new NotFoundException(error.message);
    }
  }

  @Patch(':userId/read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read for a user' })
  @ApiResponse({ status: 200 })
  async markAllAsRead(
    @Param('userId') userId: string,
  ): Promise<{ count: number }> {
    const count = await this.notificationService.markAllAsRead(userId);
    return { count };
  }

  @Get(':notificationId/deliveries')
  @ApiOperation({ summary: 'Get delivery history for a notification' })
  @ApiResponse({ status: 200 })
  async getDeliveryHistory(
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationDelivery[]> {
    return this.notificationService.getDeliveryHistory(notificationId);
  }

  @Post('schedule')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Schedule a notification for later delivery' })
  @ApiResponse({ status: 201, type: NotificationResponseDto })
  async schedule(@Body() dto: CreateNotificationDto): Promise<Notification> {
    if (!dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required for scheduled notifications');
    }
    return this.notificationService.scheduleNotification(dto);
  }

  @Patch(':notificationId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a scheduled notification' })
  @ApiResponse({ status: 200, type: NotificationResponseDto })
  async cancelScheduled(
    @Param('notificationId') notificationId: string,
    @Query('userId') userId: string,
  ): Promise<Notification> {
    if (!userId) throw new BadRequestException('userId query parameter is required');
    try {
      return await this.notificationService.cancelScheduled(notificationId, userId);
    } catch (error) {
      if (error.message.includes('not found')) throw new NotFoundException(error.message);
      throw new BadRequestException(error.message);
    }
  }

  @Get('preferences/:userId')
  @ApiOperation({ summary: 'Get notification preferences for a user' })
  @ApiResponse({ status: 200 })
  async getPreferences(
    @Param('userId') userId: string,
  ): Promise<UserNotificationPreference> {
    return this.notificationService.getPreferences(userId);
  }

  @Patch('preferences/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update notification preferences for a user' })
  @ApiResponse({ status: 200 })
  async updatePreferences(
    @Param('userId') userId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<UserNotificationPreference> {
    return this.notificationService.updatePreferences(userId, dto);
  }

  @Get('admin/metrics')
  @ApiOperation({ summary: 'Get notification service metrics' })
  @ApiResponse({ status: 200 })
  async getMetrics(): Promise<{
    queued: number;
    delivered: number;
    failed: number;
    queueDepth: number;
  }> {
    return this.notificationService.getMetrics();
  }

  @Post('admin/seed-templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Seed default notification templates' })
  @ApiResponse({ status: 201 })
  async seedTemplates(): Promise<{ count: number }> {
    const templates: Array<{
      name: string;
      type: NotificationType;
      subjectTemplate: string;
      bodyTemplate: string;
      variables: string[];
    }> = [
      {
        name: 'claim-submitted',
        type: NotificationType.CLAIM_SUBMITTED,
        subjectTemplate: 'Claim Submitted: {{claimTitle}}',
        bodyTemplate: 'Your claim "{{claimTitle}}" has been submitted successfully and is pending verification.',
        variables: ['claimTitle', 'claimId'],
      },
      {
        name: 'verification-assigned',
        type: NotificationType.VERIFICATION_ASSIGNED,
        subjectTemplate: 'Verification Requested: {{claimTitle}}',
        bodyTemplate: 'You have been assigned to verify the claim "{{claimTitle}}". Please submit your verification.',
        variables: ['claimTitle', 'claimId', 'deadline'],
      },
      {
        name: 'dispute-opened',
        type: NotificationType.DISPUTE_OPENED,
        subjectTemplate: 'Dispute Opened: {{claimTitle}}',
        bodyTemplate: 'A dispute has been opened on claim "{{claimTitle}}". Review the details and participate in resolution.',
        variables: ['claimTitle', 'claimId', 'disputeId'],
      },
      {
        name: 'rewards-distributed',
        type: NotificationType.REWARDS_DISTRIBUTED,
        subjectTemplate: 'Rewards Distributed: {{amount}}',
        bodyTemplate: 'You have received {{amount}} tokens as a reward for your participation.',
        variables: ['amount', 'tokenSymbol', 'reason'],
      },
      {
        name: 'governance-proposal',
        type: NotificationType.GOVERNANCE_PROPOSAL_CREATED,
        subjectTemplate: 'New Governance Proposal: {{proposalTitle}}',
        bodyTemplate: 'A new governance proposal "{{proposalTitle}}" has been created. Cast your vote.',
        variables: ['proposalTitle', 'proposalId', 'deadline'],
      },
      {
        name: 'reputation-update',
        type: NotificationType.REPUTATION_UPDATE,
        subjectTemplate: 'Reputation Updated: {{newScore}}',
        bodyTemplate: 'Your reputation score has been updated to {{newScore}} ({{change}}).',
        variables: ['newScore', 'change', 'reason'],
      },
      {
        name: 'staking-event',
        type: NotificationType.STAKING_EVENT,
        subjectTemplate: 'Staking Event: {{eventType}}',
        bodyTemplate: 'A staking event has occurred: {{eventType}} of {{amount}} tokens.',
        variables: ['eventType', 'amount', 'tokenSymbol'],
      },
      {
        name: 'security-alert',
        type: NotificationType.SECURITY_ALERT,
        subjectTemplate: 'Security Alert: {{alertType}}',
        bodyTemplate: 'Security alert: {{alertType}}. {{description}}',
        variables: ['alertType', 'description', 'action'],
      },
      {
        name: 'system-maintenance',
        type: NotificationType.SYSTEM_MAINTENANCE,
        subjectTemplate: 'System Maintenance: {{startTime}}',
        bodyTemplate: 'Scheduled maintenance from {{startTime}} to {{endTime}}. {{description}}',
        variables: ['startTime', 'endTime', 'description'],
      },
    ];

    let count = 0;
    for (const tpl of templates) {
      try {
        await this.templateService.createTemplate(tpl);
        count++;
      } catch (err) {
        this.logger.warn(`Template ${tpl.name} may already exist: ${err.message}`);
      }
    }

    return { count };
  }
}
