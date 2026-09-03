import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { ListNotificationsDto } from '../dto';
import { DeliveryStatus, DeliveryChannel } from '../interfaces/notification.types';

@Injectable()
export class DeliveryHistoryService {
  private readonly logger = new Logger(DeliveryHistoryService.name);

  constructor(
    @InjectRepository(DeliveryHistory)
    private readonly deliveryHistoryRepository: Repository<DeliveryHistory>,
  ) {}

  async createDeliveryRecord(
    notificationId: string, 
    channel: DeliveryChannel
  ): Promise<DeliveryHistory> {
    const record = new DeliveryHistory();
    record.notificationId = notificationId;
    record.channel = channel;
    record.status = DeliveryStatus.PENDING;
    record.retryAttempts = 0;
    record.createdAt = new Date();
    
    return this.deliveryHistoryRepository.save(record);
  }

  async updateDeliveryStatus(
    recordId: string, 
    status: DeliveryStatus, 
    error?: string
  ): Promise<DeliveryHistory> {
    const record = await this.deliveryHistoryRepository.findOne({
      where: { id: recordId },
    });
    
    if (!record) {
      this.logger.error(`Delivery record ${recordId} not found`);
      return null;
    }
    
    record.status = status;
    
    if (status === DeliveryStatus.DELIVERED) {
      record.deliveredAt = new Date();
    }
    
    if (error) {
      record.failureReason = error;
    }
    
    return this.deliveryHistoryRepository.save(record);
  }

  async incrementRetryAttempts(recordId: string): Promise<DeliveryHistory> {
    const record = await this.deliveryHistoryRepository.findOne({
      where: { id: recordId },
    });
    
    if (!record) {
      this.logger.error(`Delivery record ${recordId} not found`);
      return null;
    }
    
    record.retryAttempts += 1;
    record.lastRetryAt = new Date();
    record.status = DeliveryStatus.RETRYING;
    
    return this.deliveryHistoryRepository.save(record);
  }

  async getUserDeliveryHistory(userId: string, filters: ListNotificationsDto) {
    const { page = 1, limit = 20 } = filters;
    
    const queryBuilder = this.deliveryHistoryRepository.createQueryBuilder('history')
      .leftJoinAndSelect('history.notification', 'notification')
      .where('notification.userId = :userId', { userId })
      .orderBy('history.createdAt', 'DESC')
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

  async getDeliveryMetrics() {
    const totalDeliveries = await this.deliveryHistoryRepository.count();
    const successfulDeliveries = await this.deliveryHistoryRepository.count({
      where: { status: DeliveryStatus.DELIVERED },
    });
    const failedDeliveries = await this.deliveryHistoryRepository.count({
      where: { status: DeliveryStatus.FAILED },
    });
    const pendingDeliveries = await this.deliveryHistoryRepository.count({
      where: { status: DeliveryStatus.PENDING },
    });
    const retryingDeliveries = await this.deliveryHistoryRepository.count({
      where: { status: DeliveryStatus.RETRYING },
    });
    
    return {
      totalDeliveries,
      successfulDeliveries,
      failedDeliveries,
      pendingDeliveries,
      retryingDeliveries,
      successRate: totalDeliveries > 0 ? (successfulDeliveries / totalDeliveries) * 100 : 0,
    };
  }

  async findPendingDeliveryByNotificationAndChannel(
    notificationId: string, 
    channel: DeliveryChannel
  ): Promise<DeliveryHistory | null> {
    return this.deliveryHistoryRepository.findOne({
      where: {
        notificationId,
        channel,
        status: DeliveryStatus.PENDING,
      },
    });
  }
}