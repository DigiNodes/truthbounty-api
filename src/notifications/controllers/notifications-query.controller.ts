import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from '../entities/notification.entity';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { DeliveryTracker } from '../services/delivery-tracker.service';
import { NotificationMetricsService } from '../services/notification-metrics.service';

@ApiTags('Notifications - Query')
@Controller('api/v2/notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsQueryController {
  private readonly logger = new Logger(NotificationsQueryController.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(DeliveryHistory)
    private deliveryHistoryRepository: Repository<DeliveryHistory>,
    private deliveryTracker: DeliveryTracker,
    private metricsService: NotificationMetricsService,
  ) {}

  /**
   * List user notifications
   */
  @Get()
  @ApiOperation({ summary: 'List notifications' })
  @ApiResponse({
    status: 200,
    description: 'List of notifications',
  })
  async listNotifications(
    @CurrentUser('id') userId: string,
    @Query('skip') skip: number = 0,
    @Query('take') take: number = 50,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('read') read?: boolean,
  ): Promise<{ items: Notification[]; total: number }> {
    const query = this.notificationRepository
      .createQueryBuilder('n')
      .where('n.userId = :userId', { userId });

    if (status) {
      query.andWhere('n.status = :status', { status });
    }

    if (channel) {
      query.andWhere('n.channel = :channel', { channel });
    }

    if (read !== undefined) {
      query.andWhere('n.read = :read', { read });
    }

    const [items, total] = await query
      .orderBy('n.createdAt', 'DESC')
      .skip(skip)
      .take(take)
      .getManyAndCount();

    return { items, total };
  }

  /**
   * Get unread notification count
   */
  @Get('unread/count')
  @ApiOperation({ summary: 'Get unread count' })
  @ApiResponse({
    status: 200,
    description: 'Count of unread notifications',
  })
  async getUnreadCount(@CurrentUser('id') userId: string): Promise<{ count: number }> {
    const count = await this.notificationRepository.count({
      where: { userId, read: false },
    });

    return { count };
  }

  /**
   * Mark notification as read
   */
  @Post(':id/read')
  @ApiOperation({ summary: 'Mark as read' })
  async markAsRead(
    @CurrentUser('id') userId: string,
    @Param('id') notificationId: string,
  ): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    notification.read = true;
    notification.readAt = new Date();
    return this.notificationRepository.save(notification);
  }

  /**
   * Mark all notifications as read
   */
  @Post('read-all')
  @ApiOperation({ summary: 'Mark all as read' })
  async markAllAsRead(@CurrentUser('id') userId: string): Promise<{ updated: number }> {
    const result = await this.notificationRepository.update(
      { userId, read: false },
      { read: true, readAt: new Date() },
    );

    return { updated: result.affected || 0 };
  }

  /**
   * Get notification delivery history
   */
  @Get(':id/history')
  @ApiOperation({ summary: 'Get delivery history' })
  @ApiResponse({
    status: 200,
    description: 'Delivery history for notification',
  })
  async getDeliveryHistory(
    @CurrentUser('id') userId: string,
    @Param('id') notificationId: string,
  ): Promise<DeliveryHistory[]> {
    // Verify ownership
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    return this.deliveryHistoryRepository.find({
      where: { notificationId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get delivery status for a notification
   */
  @Get(':id/status')
  @ApiOperation({ summary: 'Get delivery status' })
  async getDeliveryStatus(
    @CurrentUser('id') userId: string,
    @Param('id') notificationId: string,
  ): Promise<any> {
    // Verify ownership
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    const history = await this.deliveryHistoryRepository.find({
      where: { notificationId },
    });

    return {
      notificationId,
      status: notification.status,
      read: notification.read,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
      deliveryHistory: history,
      summary: {
        total: history.length,
        delivered: history.filter((h) => h.status === 'delivered').length,
        failed: history.filter((h) => h.status === 'failed').length,
        pending: history.filter((h) => h.status === 'pending').length,
      },
    };
  }

  /**
   * Get delivery statistics
   */
  @Get('stats/system')
  @ApiOperation({ summary: 'Get system metrics' })
  async getSystemMetrics(): Promise<any> {
    return this.metricsService.getSystemMetrics();
  }

  /**
   * Get channel-specific metrics
   */
  @Get('stats/channels')
  @ApiOperation({ summary: 'Get channel metrics' })
  async getChannelMetrics(): Promise<any> {
    return this.metricsService.getChannelMetrics();
  }

  /**
   * Get event type metrics
   */
  @Get('stats/events')
  @ApiOperation({ summary: 'Get event type metrics' })
  async getEventTypeMetrics(): Promise<any> {
    return this.metricsService.getEventTypeMetrics();
  }

  /**
   * Get health status
   */
  @Get('health')
  @ApiOperation({ summary: 'Get system health' })
  async getHealthStatus(): Promise<any> {
    return this.metricsService.getHealthStatus();
  }
}
