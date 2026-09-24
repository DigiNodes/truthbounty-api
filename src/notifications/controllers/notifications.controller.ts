import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from '../services/notifications.service';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { ListNotificationsDto, UpdatePreferencesDto } from '../dto';
import { Notification } from '../entities/notification.entity';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly preferencesService: NotificationPreferencesService,
  ) {}

  @Get()
  async listNotifications(
    @CurrentUser('id') userId: string,
    @Query() filters: ListNotificationsDto,
  ) {
    return this.notificationsService.listNotifications(userId, filters);
  }

  @Get('unread')
  async getUnreadCount(@CurrentUser('id') userId: string) {
    const count = await this.notificationsService.getUnreadCount(userId);
    return { unreadCount: count };
  }

  @Get('history')
  async getDeliveryHistory(
    @CurrentUser('id') userId: string,
    @Query() filters: ListNotificationsDto,
  ) {
    return this.notificationsService.getDeliveryHistory(userId, filters);
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('id') notificationId: string,
  ) {
    await this.notificationsService.markAsRead(userId, notificationId);
    return { success: true };
  }

  @Put('mark-all-read')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@CurrentUser('id') userId: string) {
    await this.notificationsService.markAllAsRead(userId);
    return { success: true };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteNotification(
    @CurrentUser('id') userId: string,
    @Param('id') notificationId: string,
  ) {
    await this.notificationsService.deleteNotification(userId, notificationId);
  }

  @Get('preferences')
  async getPreferences(@CurrentUser('id') userId: string) {
    return this.preferencesService.getUserPreferences(userId);
  }

  @Put('preferences')
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body() preferences: UpdatePreferencesDto,
  ) {
    return this.preferencesService.updateUserPreferences(userId, preferences);
  }
}