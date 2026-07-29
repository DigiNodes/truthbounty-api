import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/jwt';
import { NotificationService } from '../services/notification.service';
import { UpdatePreferencesDto, NotificationQueryDto } from '../dto/notification.dto';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * Get all notifications for the current user
   */
  @Get()
  async getNotifications(
    @CurrentUser() userId: string,
    @Query() queryDto: NotificationQueryDto,
  ) {
    return this.notificationService.getUserNotifications(userId, queryDto);
  }

  /**
   * Get unread notification count
   */
  @Get('unread/count')
  async getUnreadCount(@CurrentUser() userId: string) {
    const count = await this.notificationService.getUnreadCount(userId);
    return { unreadCount: count };
  }

  /**
   * Mark a specific notification as read
   */
  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(
    @CurrentUser() userId: string,
    @Param('id') notificationId: string,
  ) {
    const notification = await this.notificationService.markAsRead(userId, notificationId);
    return { success: true, notification };
  }

  /**
   * Mark all notifications as read
   */
  @Put('mark-all-read')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@CurrentUser() userId: string) {
    await this.notificationService.markAllAsRead(userId);
    return { success: true };
  }

  /**
   * Get delivery history for audit purposes
   */
  @Get('delivery-history')
  async getDeliveryHistory(
    @CurrentUser() userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.notificationService.getDeliveryHistory(userId, limit, offset);
  }

  /**
   * Delete a notification
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteNotification(
    @CurrentUser() userId: string,
    @Param('id') notificationId: string,
  ) {
    await this.notificationService.deleteNotification(userId, notificationId);
  }

  /**
   * Get user's notification preferences
   */
  @Get('preferences')
  async getPreferences(@CurrentUser() userId: string) {
    return this.notificationService.getUserPreferences(userId);
  }

  /**
   * Update user's notification preferences
   */
  @Put('preferences')
  async updatePreferences(
    @CurrentUser() userId: string,
    @Body() updateDto: UpdatePreferencesDto,
  ) {
    const preferences = await this.notificationService.updatePreferences(userId, updateDto);
    return { success: true, preferences };
  }
}