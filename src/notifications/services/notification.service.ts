import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Notification,
  UserNotificationPreferences,
  NotificationDeliveryHistory,
  NotificationType,
  NotificationChannel,
  DeliveryStatus,
} from '../entities/notification.entity';
import {
  CreateNotificationDto,
  UpdatePreferencesDto,
  NotificationQueryDto,
} from '../dto/notification.dto';
import { NotificationGateway } from '../websockets/websocket.gateway';
import { NotificationMetricsService } from '../metrics/notification.metrics';
import { NotificationChannel as ChannelInterface } from '../channels/channel.interface';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly maxRetries = 5;
  private readonly retryDelay = 1000; // 1 second base delay, will be multiplied by 2^attempt for exponential backoff

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(UserNotificationPreferences)
    private readonly preferencesRepository: Repository<UserNotificationPreferences>,
    @InjectRepository(NotificationDeliveryHistory)
    private readonly deliveryHistoryRepository: Repository<NotificationDeliveryHistory>,
    @InjectQueue('notifications')
    private readonly notificationsQueue: Queue,
    private readonly gateway: NotificationGateway,
    private readonly metricsService: NotificationMetricsService,
    private readonly channels: ChannelInterface[],
  ) {
    // Start periodic queue depth update
    this.updateQueueMetrics();
    setInterval(() => this.updateQueueMetrics(), 10000); // Update every 10 seconds
  }

  /**
   * Create a new notification and queue it for delivery
   */
  async createNotification(createDto: CreateNotificationDto): Promise<Notification> {
    const startTime = Date.now();

    // Create the notification record
    const notification = this.notificationRepository.create(createDto);
    const savedNotification = await this.notificationRepository.save(notification);

    this.logger.debug(`Created notification ${savedNotification.id} of type ${savedNotification.type}`);
    this.metricsService.incrementCreated(savedNotification.type);

    // Queue the notification for delivery through all enabled channels
    await this.queueNotificationForDelivery(savedNotification);

    const processingTime = (Date.now() - startTime) / 1000;
    this.metricsService.observeProcessingLatency(processingTime);

    return savedNotification;
  }

  /**
   * Queue a notification for delivery through all enabled channels
   */
  private async queueNotificationForDelivery(notification: Notification) {
    // Get user preferences
    const preferences = await this.getUserPreferences(notification.recipientId);

    // Get all channels that are enabled for this user and notification type
    const enabledChannels = await this.getEnabledChannelsForUser(
      notification.recipientId,
      notification.type,
      preferences,
    );

    // Queue delivery for each enabled channel
    for (const channel of enabledChannels) {
      await this.notificationsQueue.add(
        'deliver',
        {
          notificationId: notification.id,
          channel: channel.channelType,
          retryCount: 0,
        },
        {
          attempts: this.maxRetries,
          backoff: {
            type: 'exponential',
            delay: this.retryDelay,
          },
          removeOnComplete: true,
          removeOnFail: false, // Keep failed jobs for dead-letter processing
        },
      );

      // Create initial delivery history record
      const deliveryHistory = this.deliveryHistoryRepository.create({
        notificationId: notification.id,
        recipientId: notification.recipientId,
        channel: channel.channelType as NotificationChannel,
        status: DeliveryStatus.PENDING,
        retryAttempts: 0,
      });
      await this.deliveryHistoryRepository.save(deliveryHistory);
    }
  }

  /**
   * Get all channels that are enabled for a user and notification type
   */
  private async getEnabledChannelsForUser(
    userId: string,
    notificationType: NotificationType,
    preferences: UserNotificationPreferences,
  ): Promise<ChannelInterface[]> {
    const enabledChannels: ChannelInterface[] = [];

    for (const channel of this.channels) {
      // Check if channel is globally enabled
      const channelEnabled = preferences.enabledChannels[channel.channelType] ?? true;
      
      // Check if this notification category is enabled
      const categoryEnabled = preferences.enabledCategories[notificationType] ?? true;
      
      // Check additional preference flags based on notification type
      let typeSpecificEnabled = true;
      switch (notificationType) {
        case NotificationType.GOVERNANCE_PROPOSAL:
        case NotificationType.PROPOSAL_VOTE:
          typeSpecificEnabled = preferences.governanceAlerts;
          break;
        case NotificationType.STAKING_CHANGE:
          typeSpecificEnabled = preferences.stakingAlerts;
          break;
        case NotificationType.REWARD_DISTRIBUTED:
          typeSpecificEnabled = preferences.rewardNotifications;
          break;
        case NotificationType.SECURITY_ALERT:
          typeSpecificEnabled = preferences.securityAlerts;
          break;
      }

      if (channelEnabled && categoryEnabled && typeSpecificEnabled) {
        enabledChannels.push(channel);
      }
    }

    return enabledChannels;
  }

  /**
   * Get or create user notification preferences
   */
  async getUserPreferences(userId: string): Promise<UserNotificationPreferences> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      // Create default preferences
      preferences = this.preferencesRepository.create({
        userId,
        enabledChannels: {
          [NotificationChannel.IN_APP]: true,
          [NotificationChannel.WEBSOCKET]: true,
          [NotificationChannel.PUSH]: false,
          [NotificationChannel.EMAIL]: false,
          [NotificationChannel.WEBHOOK]: false,
        },
        enabledCategories: Object.values(NotificationType).reduce((acc, type) => {
          acc[type] = true;
          return acc;
        }, {} as Record<NotificationType, boolean>),
      });
      preferences = await this.preferencesRepository.save(preferences);
    }

    return preferences;
  }

  /**
   * Update user notification preferences
   */
  async updatePreferences(
    userId: string,
    updateDto: UpdatePreferencesDto,
  ): Promise<UserNotificationPreferences> {
    const preferences = await this.getUserPreferences(userId);
    
    // Update only the provided fields
    Object.assign(preferences, updateDto);
    
    return this.preferencesRepository.save(preferences);
  }

  /**
   * Get notifications for a user with filtering and pagination
   */
  async getUserNotifications(
    userId: string,
    queryDto: NotificationQueryDto,
  ): Promise<{ notifications: Notification[]; total: number; page: number; limit: number }> {
    const { page = 1, limit = 20, type, read, startDate, endDate } = queryDto;
    
    const queryBuilder = this.notificationRepository
      .createQueryBuilder('notification')
      .where('notification.recipientId = :userId', { userId });

    if (type) {
      queryBuilder.andWhere('notification.type = :type', { type });
    }

    if (read !== undefined) {
      queryBuilder.andWhere('notification.read = :read', { read });
    }

    if (startDate) {
      queryBuilder.andWhere('notification.createdAt >= :startDate', { startDate: new Date(startDate) });
    }

    if (endDate) {
      queryBuilder.andWhere('notification.createdAt <= :endDate', { endDate: new Date(endDate) });
    }

    queryBuilder
      .orderBy('notification.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [notifications, total] = await queryBuilder.getManyAndCount();

    return { notifications, total, page, limit };
  }

  /**
   * Get unread notification count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepository.count({
      where: {
        recipientId: userId,
        read: false,
      },
    });
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(userId: string, notificationId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    if (notification.recipientId !== userId) {
      throw new ForbiddenException('You do not have permission to access this notification');
    }

    notification.read = true;
    notification.readAt = new Date();
    return this.notificationRepository.save(notification);
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<void> {
    await this.notificationRepository.update(
      { recipientId: userId, read: false },
      { read: true, readAt: new Date() },
    );
  }

  /**
   * Delete a notification
   */
  async deleteNotification(userId: string, notificationId: string): Promise<void> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, recipientId: userId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification ${notificationId} not found`);
    }

    if (notification.recipientId !== userId) {
      throw new ForbiddenException('You do not have permission to delete this notification');
    }

    // Delete associated delivery history first
    await this.deliveryHistoryRepository.delete({ notificationId });
    
    // Delete the notification
    await this.notificationRepository.remove(notification);
  }

  /**
   * Get delivery history for auditing
   */
  async getDeliveryHistory(
    userId: string,
    limit = 100,
    offset = 0,
  ): Promise<{ history: NotificationDeliveryHistory[]; total: number }> {
    const [history, total] = await this.deliveryHistoryRepository.findAndCount({
      where: { recipientId: userId },
      orderBy: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    return { history, total };
  }

  /**
   * Update queue metrics for monitoring
   */
  private async updateQueueMetrics() {
    const queueCount = await this.notificationsQueue.count();
    this.metricsService.setQueueDepth('main', queueCount);
    
    const connectedUsers = this.gateway.getConnectedUsersCount();
    this.metricsService.setConnectedUsers(connectedUsers);
  }

  /**
   * Process an incoming protocol event and convert it to a notification
   */
  async processProtocolEvent(
    source: string,
    eventType: string,
    recipientId: string,
    payload: Record<string, any>,
  ): Promise<Notification> {
    // Map protocol events to notification types
    const notificationType = this.mapToNotificationType(eventType);
    
    // Generate title and message from the event
    const { title, message } = this.generateNotificationContent(notificationType, payload);

    return this.createNotification({
      recipientId,
      type: notificationType,
      title,
      message,
      metadata: {
        source,
        eventType,
        ...payload,
      },
    });
  }

  /**
   * Map protocol event types to our internal notification types
   */
  private mapToNotificationType(eventType: string): NotificationType {
    const eventMap: Record<string, NotificationType> = {
      'claim.created': NotificationType.NEW_CLAIM,
      'verification.assigned': NotificationType.VERIFICATION_ASSIGNMENT,
      'dispute.created': NotificationType.DISPUTE_CREATED,
      'dispute.resolved': NotificationType.DISPUTE_RESOLVED,
      'reputation.updated': NotificationType.REPUTATION_UPDATE,
      'staking.changed': NotificationType.STAKING_CHANGE,
      'governance.proposal.created': NotificationType.GOVERNANCE_PROPOSAL,
      'governance.vote.cast': NotificationType.PROPOSAL_VOTE,
      'reward.distributed': NotificationType.REWARD_DISTRIBUTED,
      'moderation.action.taken': NotificationType.MODERATION_ACTION,
      'security.alert': NotificationType.SECURITY_ALERT,
    };

    return eventMap[eventType] || NotificationType.SECURITY_ALERT;
  }

  /**
   * Generate human-readable notification content from event payload
   */
  private generateNotificationContent(
    type: NotificationType,
    payload: Record<string, any>,
  ): { title: string; message: string } {
    switch (type) {
      case NotificationType.NEW_CLAIM:
        return {
          title: 'New Claim Submitted',
          message: `A new claim "${payload.title}" has been submitted and requires review.`,
        };
      case NotificationType.VERIFICATION_ASSIGNMENT:
        return {
          title: 'Verification Assigned',
          message: `You have been assigned to verify claim #${payload.claimId}.`,
        };
      case NotificationType.DISPUTE_CREATED:
        return {
          title: 'New Dispute Filed',
          message: `A dispute has been filed against claim #${payload.claimId}.`,
        };
      case NotificationType.DISPUTE_RESOLVED:
        return {
          title: 'Dispute Resolved',
          message: `Dispute for claim #${payload.claimId} has been resolved: ${payload.resolution}.`,
        };
      case NotificationType.REPUTATION_UPDATE:
        return {
          title: 'Reputation Updated',
          message: `Your reputation has changed by ${payload.change} to ${payload.newScore}.`,
        };
      case NotificationType.STAKING_CHANGE:
        return {
          title: 'Staking Balance Changed',
          message: `Your staked balance has changed. New balance: ${payload.newBalance}.`,
        };
      case NotificationType.GOVERNANCE_PROPOSAL:
        return {
          title: 'New Governance Proposal',
          message: `A new governance proposal "${payload.title}" has been created. Voting is now open.`,
        };
      case NotificationType.PROPOSAL_VOTE:
        return {
          title: 'Vote Cast on Proposal',
          message: `Your vote on proposal "${payload.proposalTitle}" has been recorded.`,
        };
      case NotificationType.REWARD_DISTRIBUTED:
        return {
          title: 'Reward Distributed',
          message: `You have received a reward of ${payload.amount} ${payload.token}.`,
        };
      case NotificationType.MODERATION_ACTION:
        return {
          title: 'Moderation Action Taken',
          message: `${payload.action} has been applied to ${payload.targetType} #${payload.targetId}.`,
        };
      case NotificationType.SECURITY_ALERT:
        return {
          title: 'Security Alert',
          message: payload.message || 'A security event has been detected on your account.',
        };
      default:
        return {
          title: 'New Notification',
          message: 'You have received a new notification.',
        };
    }
  }
}