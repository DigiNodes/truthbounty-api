import { Controller, Post, Body, Get, Param, Patch, Query, UseGuards, Request } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { GlobalAuthGuard } from '../auth/global-auth.guard';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(GlobalAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('event')
  @ApiOperation({ summary: 'Queue a new protocol event notification' })
  @ApiResponse({ status: 201, description: 'The notification has been queued.' })
  async queueEvent(@Body() createDto: CreateNotificationDto) {
    return this.notificationsService.queueNotification(createDto);
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get current user notification preferences' })
  async getPreferences(@Request() req) {
    const userId = req.user?.id || req.user?.walletAddress || 'anonymous';
    return this.notificationsService.getUserPreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update user notification preferences' })
  async updatePreferences(@Request() req, @Body() updateDto: UpdatePreferenceDto) {
    const userId = req.user?.id || req.user?.walletAddress || 'anonymous';
    return this.notificationsService.updateUserPreferences(userId, updateDto);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get notification delivery history' })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  @ApiQuery({ name: 'take', required: false, type: Number })
  async getHistory(
    @Request() req,
    @Query('skip') skip?: number,
    @Query('take') take?: number,
  ) {
    const userId = req.user?.id || req.user?.walletAddress || 'anonymous';
    const [data, total] = await this.notificationsService.getDeliveryHistory(
      userId,
      skip ? Number(skip) : 0,
      take ? Number(take) : 50,
    );
    return { data, total, skip: skip || 0, take: take || 50 };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get notification delivery metrics' })
  async getMetrics() {
    return this.notificationsService.getMetrics();
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markAsRead(@Request() req, @Param('id') id: string) {
    const userId = req.user?.id || req.user?.walletAddress || 'anonymous';
    return this.notificationsService.markAsRead(id, userId);
  }

  @Patch(':id/dismiss')
  @ApiOperation({ summary: 'Dismiss a notification' })
  async dismiss(@Request() req, @Param('id') id: string) {
    const userId = req.user?.id || req.user?.walletAddress || 'anonymous';
    return this.notificationsService.dismiss(id, userId);
  }
}
