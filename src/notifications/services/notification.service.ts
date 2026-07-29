import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual, MoreThan, FindOptionsWhere } from 'typeorm';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Notification } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { UserNotificationPreference } from '../entities/user-notification-preference.entity';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import { QueryNotificationsDto } from '../dto/query-notifications.dto';
import { UpdateNotificationPreferencesDto } from '../dto/update-notification-preferences.dto';
import {
  NotificationType,
  DeliveryChannel,
  DeliveryStatus,
  NotificationPriority,
  NotificationFrequency,
} from '../enums/notification-type.enum';
import { TemplateService } from './template.service';
import { BaseDeliveryService } from './delivery/base-delivery.service';
import { InAppDeliveryService } from './delivery/in-app-delivery.service';
import { EmailDeliveryService } from './delivery/email-delivery.service';
import { WebhookDeliveryService } from './delivery/webhook-delivery.service';
import { PushDeliveryService } from './delivery/push-delivery.service';
import { SmsDeliveryService } from './delivery/sms-delivery.service';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_RETRIES = 5;
const NOTIFICATION_QUEUE = 'notifications-queue';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private readonly deliveryServices: Map<DeliveryChannel, BaseDeliveryService> = new Map();

  private totalQueued = 0;
  private totalDelivered = 0;
  private totalFailed = 0;

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveryRepo: Repository<NotificationDelivery>,
    @InjectRepository(UserNotificationPreference)
    private readonly preferencesRepo: Repository<UserNotificationPreference>,
    private readonly templateService: TemplateService,
    private readonly configService: ConfigService,
    @InjectQueue(NOTIFICATION_QUEUE)
    private readonly notificationQueue: Queue,
    inAppDelivery: InAppDeliveryService,
    emailDelivery: EmailDeliveryService,
    webhookDelivery: WebhookDeliveryService,
    pushDelivery: PushDeliveryService,
    smsDelivery: SmsDeliveryService,
  ) {
    this.deliveryServices.set(DeliveryChannel.IN_APP, inAppDelivery);
    this.deliveryServices.set(DeliveryChannel.EMAIL, emailDelivery);
    this.deliveryServices.set(DeliveryChannel.WEBHOOK, webhookDelivery);
    this.deliveryServices.set(DeliveryChannel.PUSH, pushDelivery);
    this.deliveryServices.set(DeliveryChannel.SMS, smsDelivery);
  }

  async onModuleInit() {
    this.logger.log('NotificationService initialized');
  }

  async create(data: CreateNotificationDto): Promise<Notification> {
    const notification = this.notificationRepo.create({
      type: data.type,
      userId: data.userId,
      walletAddress: data.walletAddress,
      title: data.title,
      body: data.body,
      data: data.data || {},
      priority: data.priority || NotificationPriority.NORMAL,
      status: 'PENDING',
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
    });

    const saved = await this.notificationRepo.save(notification);

    const channels = data.channels || await this.resolveChannels(data.userId, data.type);
    const preferences = await this.getOrCreatePreferences(data.userId);

    for (const channel of channels) {
      const reason = this.evaluateChannelEligibility(channel, preferences, data.type);
      if (reason) {
        this.logger.debug(`Skipping ${channel} for notification ${saved.id}: ${reason}`);
        continue;
      }

      const destination = this.resolveDestination(channel, preferences);
      const delivery = this.deliveryRepo.create({
        notificationId: saved.id,
        channel,
        status: DeliveryStatus.PENDING,
        destination,
        maxRetries: MAX_RETRIES,
        queuedAt: new Date(),
      });
      await this.deliveryRepo.save(delivery);
    }

    await this.enqueueDelivery(saved.id);
    this.totalQueued++;

    const result = await this.notificationRepo.findOne({
      where: { id: saved.id },
      relations: ['deliveries'],
    });
    return result!;
  }

  async enqueueDelivery(notificationId: string, delayMs = 0): Promise<void> {
    await this.notificationQueue.add(
      'deliver-notification',
      { notificationId },
      {
        delay: delayMs,
        attempts: MAX_RETRIES,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }

  async processDelivery(notificationId: string): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId },
      relations: ['deliveries'],
    });

    if (!notification) {
      this.logger.warn(`Notification ${notificationId} not found for delivery`);
      return;
    }

    const pendingDeliveries = notification.deliveries.filter(
      (d) => d.status === DeliveryStatus.PENDING || d.status === DeliveryStatus.QUEUED,
    );

    if (pendingDeliveries.length === 0) {
      this.logger.debug(`Notification ${notificationId} has no pending deliveries`);
      return;
    }

    notification.status = 'SENDING';
    await this.notificationRepo.save(notification);

    let allSucceeded = true;

    for (const delivery of pendingDeliveries) {
      const service = this.deliveryServices.get(delivery.channel as DeliveryChannel);
      if (!service) {
        this.logger.warn(`No delivery service for channel ${delivery.channel}`);
        delivery.status = DeliveryStatus.FAILED;
        delivery.failureReason = `Unsupported channel: ${delivery.channel}`;
        await this.deliveryRepo.save(delivery);
        allSucceeded = false;
        continue;
      }

      delivery.status = DeliveryStatus.SENT;
      delivery.sentAt = new Date();
      delivery.responseData = {
        type: notification.type,
        title: notification.title,
        body: notification.body,
        data: notification.data,
      };
      await this.deliveryRepo.save(delivery);

      try {
        const result = await service.deliver(delivery);

        if (result.success) {
          delivery.status = DeliveryStatus.DELIVERED;
          delivery.deliveredAt = result.deliveredAt || new Date();
          if (result.responseData) {
            delivery.responseData = { ...delivery.responseData, ...result.responseData };
          }
          this.totalDelivered++;
        } else {
          delivery.retryCount += 1;
          delivery.status = delivery.retryCount >= delivery.maxRetries
            ? DeliveryStatus.FAILED
            : DeliveryStatus.PENDING;
          delivery.failureReason = result.failureReason || null;
          delivery.lastRetryAt = new Date();
          if (result.responseData) {
            delivery.responseData = { ...delivery.responseData, ...result.responseData };
          }
          allSucceeded = false;
          this.totalFailed++;

          if (delivery.status === DeliveryStatus.PENDING) {
            await this.enqueueDelivery(notificationId, 2000 * Math.pow(2, delivery.retryCount));
          }
        }

        await this.deliveryRepo.save(delivery);
      } catch (error) {
        delivery.status = DeliveryStatus.FAILED;
        delivery.failureReason = error instanceof Error ? error.message : 'Unknown delivery error';
        delivery.retryCount += 1;
        delivery.lastRetryAt = new Date();
        allSucceeded = false;
        this.totalFailed++;
        await this.deliveryRepo.save(delivery);
      }
    }

    notification.status = allSucceeded ? 'DELIVERED' : 'PARTIALLY_DELIVERED';
    notification.sentAt = new Date();
    await this.notificationRepo.save(notification);
  }

  async getUserNotifications(
    userId: string,
    query: QueryNotificationsDto,
  ): Promise<{ notifications: Notification[]; total: number }> {
    const where: FindOptionsWhere<Notification> = { userId };
    const limit = Math.min(query.limit || DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const offset = query.offset || 0;

    if (query.read !== undefined) where.read = query.read;
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;

    const [notifications, total] = await this.notificationRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
      relations: ['deliveries'],
    });

    return { notifications, total };
  }

  async markAsRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    notification.read = true;
    notification.readAt = new Date();
    return this.notificationRepo.save(notification);
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.notificationRepo.update(
      { userId, read: false },
      { read: true, readAt: new Date() },
    );
    return result.affected || 0;
  }

  async getDeliveryHistory(
    notificationId: string,
  ): Promise<NotificationDelivery[]> {
    return this.deliveryRepo.find({
      where: { notificationId },
      order: { createdAt: 'ASC' },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepo.count({
      where: { userId, read: false },
    });
  }

  async getOrCreatePreferences(userId: string): Promise<UserNotificationPreference> {
    let preferences = await this.preferencesRepo.findOne({ where: { userId } });

    if (!preferences) {
      preferences = this.preferencesRepo.create({
        userId,
        enabledChannels: [DeliveryChannel.IN_APP],
        frequency: NotificationFrequency.INSTANT,
        notificationsEnabled: true,
        subscribedCategories: [],
        unsubscribedCategories: [],
      });
      preferences = await this.preferencesRepo.save(preferences);
    }

    return preferences;
  }

  async updatePreferences(
    userId: string,
    data: UpdateNotificationPreferencesDto,
  ): Promise<UserNotificationPreference> {
    const preferences = await this.getOrCreatePreferences(userId);

    if (data.enabledChannels !== undefined) preferences.enabledChannels = data.enabledChannels.map(c => c.toString());
    if (data.frequency !== undefined) preferences.frequency = data.frequency;
    if (data.quietHoursStart !== undefined) preferences.quietHoursStart = [data.quietHoursStart] as string[];
    if (data.quietHoursEnd !== undefined) preferences.quietHoursEnd = [data.quietHoursEnd] as string[];
    if (data.subscribedCategories !== undefined) preferences.subscribedCategories = data.subscribedCategories;
    if (data.unsubscribedCategories !== undefined) preferences.unsubscribedCategories = data.unsubscribedCategories;
    if (data.digestEnabled !== undefined) preferences.digestEnabled = data.digestEnabled;
    if (data.digestFrequency !== undefined) preferences.digestFrequency = data.digestFrequency;
    if (data.emailAddress !== undefined) preferences.emailAddress = data.emailAddress;
    if (data.webhookUrl !== undefined) preferences.webhookUrl = data.webhookUrl;
    if (data.pushToken !== undefined) preferences.pushToken = data.pushToken;
    if (data.notificationsEnabled !== undefined) preferences.notificationsEnabled = data.notificationsEnabled;

    return this.preferencesRepo.save(preferences);
  }

  async getPreferences(userId: string): Promise<UserNotificationPreference> {
    return this.getOrCreatePreferences(userId);
  }

  async scheduleNotification(data: CreateNotificationDto): Promise<Notification> {
    if (!data.scheduledAt) {
      data.scheduledAt = new Date(Date.now() + 3600000).toISOString();
    }
    return this.create(data);
  }

  async cancelScheduled(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new Error('Notification not found');
    }

    if (notification.status !== 'PENDING') {
      throw new Error('Can only cancel pending notifications');
    }

    notification.status = 'CANCELLED';
    await this.notificationRepo.save(notification);

    await this.deliveryRepo.update(
      { notificationId, status: DeliveryStatus.PENDING },
      { status: DeliveryStatus.CANCELLED },
    );

    return notification;
  }

  async getMetrics(): Promise<{
    queued: number;
    delivered: number;
    failed: number;
    queueDepth: number;
  }> {
    const queueDepth = await this.notificationQueue.getWaitingCount()
      + await this.notificationQueue.getActiveCount()
      + await this.notificationQueue.getDelayedCount();

    const failedDeliveries = await this.deliveryRepo.count({
      where: { status: DeliveryStatus.FAILED },
    });

    return {
      queued: this.totalQueued,
      delivered: this.totalDelivered,
      failed: failedDeliveries || this.totalFailed,
      queueDepth,
    };
  }

  async getWebhookMetrics(): Promise<{
    total: number;
    delivered: number;
    pending: number;
    failed: number;
  }> {
    const [total, delivered, pending, failed] = await Promise.all([
      this.deliveryRepo.count({ where: { channel: DeliveryChannel.WEBHOOK } }),
      this.deliveryRepo.count({ where: { channel: DeliveryChannel.WEBHOOK, status: DeliveryStatus.DELIVERED } }),
      this.deliveryRepo.count({ where: { channel: DeliveryChannel.WEBHOOK, status: DeliveryStatus.PENDING } }),
      this.deliveryRepo.count({ where: { channel: DeliveryChannel.WEBHOOK, status: DeliveryStatus.FAILED } }),
    ]);

    return {
      total,
      delivered,
      pending,
      failed,
    };
  }

  private async resolveChannels(
    userId: string,
    type: NotificationType,
  ): Promise<DeliveryChannel[]> {
    const preferences = await this.getOrCreatePreferences(userId);

    if (!preferences.notificationsEnabled) {
      return [];
    }

    const categories = preferences.subscribedCategories || [];
    if (categories.length > 0 && !categories.includes(type)) {
      const unsubscribed = preferences.unsubscribedCategories || [];
      if (unsubscribed.includes(type)) {
        return [];
      }
    }

    if (preferences.frequency === NotificationFrequency.INSTANT) {
      const channels = preferences.enabledChannels.map((c) => c as DeliveryChannel);
      return channels.length > 0 ? channels : [DeliveryChannel.IN_APP];
    }

    return [];
  }

  private evaluateChannelEligibility(
    channel: DeliveryChannel,
    preferences: UserNotificationPreference,
    type: NotificationType,
  ): string | null {
    const enabledChannels = (preferences.enabledChannels || []).map(c => c as DeliveryChannel);
    if (!enabledChannels.includes(channel)) {
      return `Channel ${channel} not enabled`;
    }

    const unsubscribed = preferences.unsubscribedCategories || [];
    if (unsubscribed.includes(type)) {
      return `Category ${type} is unsubscribed`;
    }

    if (preferences.quietHoursStart && preferences.quietHoursStart.length > 0 && preferences.quietHoursEnd && preferences.quietHoursEnd.length > 0) {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const current = hours * 60 + minutes;
      const startParts = preferences.quietHoursStart[0].split(':').map(Number);
      const endParts = preferences.quietHoursEnd[0].split(':').map(Number);
      const start = startParts[0] * 60 + (startParts[1] || 0);
      const end = endParts[0] * 60 + (endParts[1] || 0);

      if (start <= end) {
        if (current >= start && current < end) return 'Quiet hours active';
      } else {
        if (current >= start || current < end) return 'Quiet hours active';
      }
    }

    return null;
  }

  private resolveDestination(
    channel: DeliveryChannel,
    preferences: UserNotificationPreference,
  ): string | undefined {
    switch (channel) {
      case DeliveryChannel.EMAIL:
        return preferences.emailAddress;
      case DeliveryChannel.WEBHOOK:
        return preferences.webhookUrl;
      case DeliveryChannel.PUSH:
        return preferences.pushToken;
      case DeliveryChannel.SMS:
        return undefined;
      default:
        return undefined;
    }
  }
}
