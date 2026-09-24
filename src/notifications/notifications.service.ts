import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdatePreferenceDto } from './dto/update-preference.dto';
import { NotificationStatus } from './enums/notification-status.enum';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(NotificationPreference)
    private preferenceRepository: Repository<NotificationPreference>,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async queueNotification(createDto: CreateNotificationDto): Promise<Notification> {
    const notification = this.notificationRepository.create(createDto);
    notification.status = NotificationStatus.QUEUED;
    const savedNotification = await this.notificationRepository.save(notification);

    await this.notificationQueue.add('send', { notificationId: savedNotification.id }, {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 2000, // 2s, 4s, 8s, 16s
      },
    });

    this.logger.log(`Queued notification ${savedNotification.id} for user ${savedNotification.userId}`);
    return savedNotification;
  }

  async getUserPreferences(userId: string): Promise<NotificationPreference> {
    let pref = await this.preferenceRepository.findOne({ where: { userId } });
    if (!pref) {
      pref = this.preferenceRepository.create({ userId });
      pref = await this.preferenceRepository.save(pref);
    }
    return pref;
  }

  async updateUserPreferences(userId: string, updateDto: UpdatePreferenceDto): Promise<NotificationPreference> {
    const pref = await this.getUserPreferences(userId);
    Object.assign(pref, updateDto);
    return this.preferenceRepository.save(pref);
  }

  async getDeliveryHistory(userId: string, skip = 0, take = 50): Promise<[Notification[], number]> {
    return this.notificationRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip,
      take,
    });
  }

  async getMetrics(): Promise<any> {
    const total = await this.notificationRepository.count();
    const delivered = await this.notificationRepository.count({ where: { status: NotificationStatus.DELIVERED } });
    const failed = await this.notificationRepository.count({ where: { status: NotificationStatus.FAILED } });
    const queued = await this.notificationRepository.count({ where: { status: NotificationStatus.QUEUED } });
    
    return {
      total,
      delivered,
      failed,
      queued,
      successRate: total > 0 ? (delivered / total) * 100 : 0,
    };
  }

  async markAsRead(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({ where: { id: notificationId, userId } });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    notification.status = NotificationStatus.READ;
    return this.notificationRepository.save(notification);
  }

  async dismiss(notificationId: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({ where: { id: notificationId, userId } });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    notification.status = NotificationStatus.DISMISSED;
    return this.notificationRepository.save(notification);
  }
}
