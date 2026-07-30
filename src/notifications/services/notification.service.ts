import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Notification } from '../entities/notification.entity';
import { NotificationDelivery } from '../entities/notification-delivery.entity';
import { UserNotificationPreference } from '../entities/user-notification-preference.entity';
import { TemplateService } from './template.service';
import { CreateNotificationDto } from '../dto/create-notification.dto';
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationFrequency,
} from '../enums/notification-type.enum';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(NotificationDelivery)
    private readonly deliveryRepo: Repository<NotificationDelivery>,
    @InjectRepository(UserNotificationPreference)
    private readonly preferencesRepo: Repository<UserNotificationPreference>,
    @InjectQueue('notifications-queue')
    private readonly queue: Queue,
    private readonly templateService: TemplateService,
    private readonly configService: ConfigService,
  ) {}

  async create(dto: CreateNotificationDto): Promise<Notification> {
    const preferences = await this.preferencesRepo.findOne({ where: { userId: dto.userId } });

    const notification = this.notificationRepo.create({
      recipientId: dto.userId,
      type: dto.type,
      title: dto.title,
      message: dto.body,
      metadata: dto.data ?? {},
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const savedNotification = await this.notificationRepo.save(notification);

    if (!preferences) {
      await this.getOrCreatePreferences(dto.userId);
    }

    if (preferences?.notificationsEnabled === false) {
      return savedNotification;
    }

    const delivery = this.deliveryRepo.create({
      notificationId: savedNotification.id,
      recipientId: dto.userId,
      channel: DeliveryChannel.IN_APP,
      status: DeliveryStatus.PENDING,
      retryCount: 0,
      maxRetries: 5,
      queuedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    await this.deliveryRepo.save(delivery);

    await this.queue.add(
      'deliver-notification',
      { notificationId: savedNotification.id },
      {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
    );

    return savedNotification;
  }

  async processDelivery(notificationId: string): Promise<void> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId },
    } as any);

    if (!notification) {
      return;
    }

    const deliveries = (notification as any).deliveries ?? [];

    for (const delivery of deliveries) {
      if (delivery.channel === DeliveryChannel.WEBHOOK && !delivery.destination) {
        delivery.status = DeliveryStatus.FAILED;
        await this.deliveryRepo.save(delivery);
        await this.queue.add('deliver-notification', { notificationId }, { attempts: 5 });
        continue;
      }

      delivery.status = DeliveryStatus.DELIVERED;
      await this.deliveryRepo.save(delivery);
    }

    await this.notificationRepo.save(notification);
  }

  async getOrCreatePreferences(userId: string): Promise<UserNotificationPreference> {
    const existing = await this.preferencesRepo.findOne({ where: { userId } });
    if (existing) return existing;

    const preferences = this.preferencesRepo.create({
      userId,
      enabledChannels: [DeliveryChannel.IN_APP, DeliveryChannel.EMAIL],
      frequency: NotificationFrequency.INSTANT,
      quietHoursStart: [],
      quietHoursEnd: [],
      subscribedCategories: [],
      unsubscribedCategories: [],
      digestEnabled: false,
      emailAddress: null,
      webhookUrl: null,
      pushToken: null,
      pushPlatforms: [],
      notificationsEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    return this.preferencesRepo.save(preferences);
  }

  async updatePreferences(userId: string, updateDto: Partial<UserNotificationPreference>): Promise<UserNotificationPreference> {
    const preferences = await this.preferencesRepo.findOne({ where: { userId } });
    if (!preferences) {
      throw new NotFoundException('Preferences not found');
    }

    Object.assign(preferences, updateDto, { updatedAt: new Date() });
    return this.preferencesRepo.save(preferences);
  }

  async markAsRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, recipientId: userId },
    } as any);

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    notification.read = true;
    notification.readAt = new Date();
    return this.notificationRepo.save(notification);
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.notificationRepo.update(
      { recipientId: userId, read: false },
      { read: true, readAt: new Date() },
    );
    return (result as any).affected ?? 0;
  }

  async scheduleNotification(dto: CreateNotificationDto): Promise<Notification> {
    return this.create(dto);
  }

  async cancelScheduled(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepo.findOne({
      where: { id: notificationId, recipientId: userId },
    } as any);

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.deliveryRepo.update(
      { notificationId, status: DeliveryStatus.PENDING },
      { status: DeliveryStatus.CANCELLED },
    );

    (notification as any).status = DeliveryStatus.CANCELLED;
    return this.notificationRepo.save(notification);
  }

  async getUserNotifications(userId: string, query: Record<string, unknown>): Promise<{ notifications: Notification[]; total: number }> {
    const [notifications, total] = await this.notificationRepo.findAndCount({
      where: { recipientId: userId } as any,
    });

    return {
      notifications,
      total,
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepo.count({ where: { recipientId: userId, read: false } as any });
  }

  async getDeliveryHistory(notificationId: string): Promise<NotificationDelivery[]> {
    return this.deliveryRepo.find({ where: { notificationId } as any });
  }

  async getMetrics(): Promise<{ queued: number; delivered: number; failed: number; queueDepth: number }> {
    const [queued, delivered, failed, waiting, active, delayed] = await Promise.all([
      this.deliveryRepo.count({ where: { status: DeliveryStatus.QUEUED } as any }),
      this.deliveryRepo.count({ where: { status: DeliveryStatus.DELIVERED } as any }),
      this.deliveryRepo.count({ where: { status: DeliveryStatus.FAILED } as any }),
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getDelayedCount(),
    ]);

    return {
      queued,
      delivered,
      failed,
      queueDepth: waiting + active + delayed,
    };
  }
}
