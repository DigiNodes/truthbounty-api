import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { Queue } from 'bullmq';
import { Notification } from '../entities/notification.entity';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { DeliveryHistoryService } from './delivery-history.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { ListNotificationsDto } from '../dto';
import { NotificationEvent, NotificationCategory, NotificationPriority } from '../interfaces/notification.types';
import { MetricsService } from '../../metrics/metrics.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectQueue('notifications')
    private readonly notificationsQueue: Queue,
    private readonly deliveryHistoryService: DeliveryHistoryService,
    private readonly preferencesService: NotificationPreferencesService,
    private readonly metricsService: MetricsService,
  ) {}

  async listNotifications(userId: string, filters: ListNotificationsDto) {
    const { page = 1, limit = 20, unreadOnly, category, priority, fromDate, toDate } = filters;
    const queryBuilder = this.notificationRepository.createQueryBuilder('notification');
    
    queryBuilder.where('notification.userId = :userId', { userId });
    
    if (unreadOnly) {
      queryBuilder.andWhere('notification.read = false');
    }
    
    if (category) {
      queryBuilder.andWhere('notification.category = :category', { category });
    }
    
    if (priority) {
      queryBuilder.andWhere('notification.priority = :priority', { priority });
    }
    
    if (fromDate && toDate) {
      queryBuilder.andWhere('notification.createdAt BETWEEN :fromDate AND :toDate', {
        fromDate: new Date(fromDate),
        toDate: new Date(toDate),
      });
    } else if (fromDate) {
      queryBuilder.andWhere('notification.createdAt >= :fromDate', { fromDate: new Date(fromDate) });
    } else if (toDate) {
      queryBuilder.andWhere('notification.createdAt <= :toDate', { toDate: new Date(toDate) });
    }
    
    queryBuilder.orderBy('notification.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    
    const [items, total] = await queryBuilder.getManyAndCount();
    
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepository.count({
      where: { userId, read: false },
    });
  }

  async getDeliveryHistory(userId: string, filters: ListNotificationsDto) {
    return this.deliveryHistoryService.getUserDeliveryHistory(userId, filters);
  }

  async markAsRead(userId: string, notificationId: string): Promise<void> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });
    
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    
    if (notification.userId !== userId) {
      throw new ForbiddenException('You do not have access to this notification');
    }
    
    notification.read = true;
    notification.readAt = new Date();
    await this.notificationRepository.save(notification);
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.notificationRepository.update(
      { userId, read: false },
      { read: true, readAt: new Date() }
    );
  }

  async deleteNotification(userId: string, notificationId: string): Promise<void> {
    const notification = await this.notificationRepository.findOne({
      where: { id: notificationId, userId },
    });
    
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    
    if (notification.userId !== userId) {
      throw new ForbiddenException('You do not have access to this notification');
    }
    
    await this.notificationRepository.remove(notification);
  }

  async processIncomingEvent(event: NotificationEvent): Promise<void> {
    this.logger.log(`Processing incoming event: ${event.eventType} from ${event.source}`);
    
    for (const recipientId of event.recipientIds) {
      try {
        const preferences = await this.preferencesService.getUserPreferences(recipientId);
        
        if (!this.shouldSendNotification(preferences, event)) {
          this.logger.debug(`User ${recipientId} has disabled notifications for ${event.eventType}`);
          continue;
        }
        
        const notification = this.createNotificationFromEvent(event, recipientId);
        const savedNotification = await this.notificationRepository.save(notification);
        
        await this.queueNotificationForDelivery(savedNotification, preferences);
        
        this.metricsService.incrementCounter('notifications_created_total', 1);
        this.logger.debug(`Notification created for user ${recipientId}: ${savedNotification.id}`);
      } catch (error) {
        this.logger.error(`Failed to process notification for user ${recipientId}`, error);
        this.metricsService.incrementCounter('notifications_failed_to_create_total', 1);
      }
    }
  }

  private shouldSendNotification(preferences: any, event: NotificationEvent): boolean {
    const category = this.mapEventTypeToCategory(event.eventType);
    
    if (!preferences.settings.categories[category]) {
      return false;
    }
    
    if (category === NotificationCategory.GOVERNANCE_PROPOSAL && !preferences.settings.governanceAlerts) {
      return false;
    }
    
    if (category === NotificationCategory.STAKING_CHANGE && !preferences.settings.stakingAlerts) {
      return false;
    }
    
    if (category === NotificationCategory.REWARD_DISTRIBUTION && !preferences.settings.rewardNotifications) {
      return false;
    }
    
    if (category === NotificationCategory.SECURITY_ALERT && !preferences.settings.securityAlerts) {
      return false;
    }
    
    return true;
  }

  private mapEventTypeToCategory(eventType: string): NotificationCategory {
    const categoryMap: Record<string, NotificationCategory> = {
      'claim.created': NotificationCategory.NEW_CLAIM,
      'verification.assigned': NotificationCategory.VERIFICATION_ASSIGNMENT,
      'dispute.created': NotificationCategory.DISPUTE_CREATED,
      'dispute.resolved': NotificationCategory.DISPUTE_RESOLVED,
      'reputation.updated': NotificationCategory.REPUTATION_UPDATE,
      'stake.changed': NotificationCategory.STAKING_CHANGE,
      'governance.proposal.created': NotificationCategory.GOVERNANCE_PROPOSAL,
      'governance.voting.reminder': NotificationCategory.VOTING_DEADLINE,
      'reward.distributed': NotificationCategory.REWARD_DISTRIBUTION,
      'moderation.action': NotificationCategory.MODERATION_ACTION,
      'security.alert': NotificationCategory.SECURITY_ALERT,
    };
    
    return categoryMap[eventType] || NotificationCategory.SYSTEM_UPDATE;
  }

  private createNotificationFromEvent(event: NotificationEvent, recipientId: string): Partial<Notification> {
    const category = this.mapEventTypeToCategory(event.eventType);
    const { title, message, priority = NotificationPriority.MEDIUM } = this.extractNotificationContent(event);
    
    return {
      userId: recipientId,
      title,
      message,
      category,
      priority,
      metadata: event.payload,
      sourceEvent: event,
      read: false,
      createdAt: new Date(),
    };
  }

  private extractNotificationContent(event: NotificationEvent) {
    const eventContentMap: Record<string, { title: string; message: string; priority?: NotificationPriority }> = {
      'claim.created': {
        title: 'New Claim Submitted',
        message: `A new claim "${event.payload.title}" has been submitted to the protocol.`,
      },
      'verification.assigned': {
        title: 'Verification Assignment',
        message: `You have been assigned to verify claim #${event.payload.claimId}.`,
        priority: NotificationPriority.HIGH,
      },
      'dispute.created': {
        title: 'Dispute Filed',
        message: `A dispute has been filed against claim #${event.payload.claimId}.`,
        priority: NotificationPriority.HIGH,
      },
      'dispute.resolved': {
        title: 'Dispute Resolved',
        message: `The dispute for claim #${event.payload.claimId} has been resolved.`,
      },
      'reputation.updated': {
        title: 'Reputation Update',
        message: `Your reputation score has changed to ${event.payload.newScore}.`,
      },
      'stake.changed': {
        title: 'Staking Update',
        message: `Your staked balance has been updated to ${event.payload.newBalance}.`,
      },
      'governance.proposal.created': {
        title: 'New Governance Proposal',
        message: `A new proposal "${event.payload.title}" is available for voting.`,
      },
      'governance.voting.reminder': {
        title: 'Voting Deadline Approaching',
        message: `Voting for proposal "${event.payload.title}" ends in 24 hours.`,
        priority: NotificationPriority.HIGH,
      },
      'reward.distributed': {
        title: 'Reward Distributed',
        message: `You have received a reward of ${event.payload.amount} ${event.payload.token}.`,
      },
      'security.alert': {
        title: 'Security Alert',
        message: event.payload.message,
        priority: NotificationPriority.CRITICAL,
      },
    };

    return eventContentMap[event.eventType] || {
      title: 'System Update',
      message: 'An event has occurred in the protocol.',
    };
  }

  private async queueNotificationForDelivery(notification: Notification, preferences: NotificationPreference) {
    const enabledChannels = preferences.settings.enabledChannels;
    
    for (const channel of enabledChannels) {
      await this.deliveryHistoryService.createDeliveryRecord(notification.id, channel);
      
      await this.notificationsQueue.add(
        'deliver-notification',
        {
          notificationId: notification.id,
          channel,
          userId: notification.userId,
        },
        {
          priority: this.getJobPriority(notification.priority),
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        }
      );
    }
  }

  private getJobPriority(priority: NotificationPriority): number {
    const priorityMap = {
      [NotificationPriority.CRITICAL]: 1,
      [NotificationPriority.HIGH]: 2,
      [NotificationPriority.MEDIUM]: 3,
      [NotificationPriority.LOW]: 4,
    };
    return priorityMap[priority] || 3;
  }
}