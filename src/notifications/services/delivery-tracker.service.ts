import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { DeliveryChannel, DeliveryStatus } from '../interfaces/notification.types';
import { RedisService } from '../../redis/redis.service';

/**
 * DeliveryTracker
 * 
 * Tracks notification delivery history and provides idempotency guards.
 * Uses two-level idempotency to prevent duplicate deliveries:
 * 1. Redis guard (fast, TTL-based)
 * 2. Database guard (reliable, persistent)
 */
@Injectable()
export class DeliveryTracker {
  private readonly logger = new Logger(DeliveryTracker.name);

  // Idempotency guard TTL: 24 hours
  private readonly IDEMPOTENCY_TTL_SECONDS = 86400;

  constructor(
    @InjectRepository(DeliveryHistory)
    private deliveryHistoryRepository: Repository<DeliveryHistory>,
    private redisService: RedisService,
  ) {}

  /**
   * Check idempotency and track delivery
   * Returns true if should proceed, false if already delivered
   */
  async checkIdempotency(idempotencyKey: string): Promise<boolean> {
    // Fast path: Redis guard
    const redisKey = `delivery:idempotency:${idempotencyKey}`;
    const alreadyDelivered = await this.redisService.get(redisKey);

    if (alreadyDelivered) {
      this.logger.debug(`Idempotency guard hit (Redis): ${idempotencyKey}`);
      return false;
    }

    // Reliable path: Database guard
    const history = await this.deliveryHistoryRepository.findOne({
      where: { idempotencyKey },
    });

    if (history && history.status === 'delivered') {
      // Set Redis guard for future checks
      await this.redisService.set(
        redisKey,
        'true',
        this.IDEMPOTENCY_TTL_SECONDS,
      );
      this.logger.debug(`Idempotency guard hit (DB): ${idempotencyKey}`);
      return false;
    }

    // Mark as attempted (optimistic lock)
    await this.redisService.setnx(redisKey, 'true', this.IDEMPOTENCY_TTL_SECONDS);

    return true;
  }

  /**
   * Record successful delivery
   */
  async recordDelivery(
    notificationId: string,
    userId: string,
    channel: DeliveryChannel,
    idempotencyKey: string,
    metadata?: Record<string, any>,
  ): Promise<DeliveryHistory> {
    let history = await this.deliveryHistoryRepository.findOne({
      where: { idempotencyKey },
    });

    if (!history) {
      history = this.deliveryHistoryRepository.create({
        notificationId,
        channel,
        status: 'delivered' as any,
        deliveredAt: new Date(),
        idempotencyKey,
        metadata,
        retryAttempts: 0,
      });
    } else {
      history.status = 'delivered' as any;
      history.deliveredAt = new Date();
      if (metadata) history.metadata = metadata;
    }

    return this.deliveryHistoryRepository.save(history);
  }

  /**
   * Record delivery failure
   */
  async recordFailure(
    notificationId: string,
    channel: DeliveryChannel,
    failureReason: string,
    idempotencyKey?: string,
    retryAttempts: number = 0,
    metadata?: Record<string, any>,
  ): Promise<DeliveryHistory> {
    let history = await this.deliveryHistoryRepository.findOne({
      where: { idempotencyKey },
    });

    if (!history) {
      history = this.deliveryHistoryRepository.create({
        notificationId,
        channel,
        status: 'failed' as any,
        failureReason,
        retryAttempts,
        idempotencyKey,
        metadata,
      });
    } else {
      history.status = 'failed' as any;
      history.failureReason = failureReason;
      history.retryAttempts = retryAttempts;
      if (metadata) history.metadata = metadata;
    }

    return this.deliveryHistoryRepository.save(history);
  }

  /**
   * Record retry attempt
   */
  async recordRetry(
    notificationId: string,
    channel: DeliveryChannel,
    retryAttempt: number,
    idempotencyKey?: string,
    metadata?: Record<string, any>,
  ): Promise<DeliveryHistory> {
    let history = await this.deliveryHistoryRepository.findOne({
      where: { idempotencyKey },
    });

    if (!history) {
      history = this.deliveryHistoryRepository.create({
        notificationId,
        channel,
        status: 'retrying' as any,
        retryAttempts: retryAttempt,
        lastRetryAt: new Date(),
        idempotencyKey,
        metadata,
      });
    } else {
      history.status = 'retrying' as any;
      history.retryAttempts = retryAttempt;
      history.lastRetryAt = new Date();
      if (metadata) history.metadata = metadata;
    }

    return this.deliveryHistoryRepository.save(history);
  }

  /**
   * Get delivery history for a notification
   */
  async getNotificationHistory(
    notificationId: string,
  ): Promise<DeliveryHistory[]> {
    return this.deliveryHistoryRepository.find({
      where: { notificationId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get delivery history for a user
   */
  async getUserDeliveryHistory(
    userId: string,
    skip: number = 0,
    take: number = 50,
  ): Promise<{ items: DeliveryHistory[]; total: number }> {
    // TODO: This requires a join to notifications table
    // Placeholder for now
    const [items, total] = await this.deliveryHistoryRepository.findAndCount({
      skip,
      take,
      order: { createdAt: 'DESC' },
    });

    return { items, total };
  }

  /**
   * Get delivery statistics
   */
  async getDeliveryStats(
    startDate: Date,
    endDate: Date,
    channel?: DeliveryChannel,
  ): Promise<{
    total: number;
    delivered: number;
    failed: number;
    retrying: number;
    successRate: number;
    byChannel: Record<DeliveryChannel, { total: number; delivered: number; failed: number }>;
  }> {
    const query = this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .where('dh.createdAt BETWEEN :start AND :end', { start: startDate, end: endDate });

    if (channel) {
      query.andWhere('dh.channel = :channel', { channel });
    }

    const [all, delivered, failed, retrying] = await Promise.all([
      query.getCount(),
      query.clone().andWhere('dh.status = :status', { status: 'delivered' }).getCount(),
      query.clone().andWhere('dh.status = :status', { status: 'failed' }).getCount(),
      query.clone().andWhere('dh.status = :status', { status: 'retrying' }).getCount(),
    ]);

    // Group by channel
    const byChannelResult = await this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .select('dh.channel', 'channel')
      .addSelect('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN dh.status = 'delivered' THEN 1 ELSE 0 END)", 'delivered')
      .addSelect("SUM(CASE WHEN dh.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
      .where('dh.createdAt BETWEEN :start AND :end', { start: startDate, end: endDate })
      .groupBy('dh.channel')
      .getRawMany();

    const byChannel: Record<DeliveryChannel, any> = {} as any;
    for (const row of byChannelResult) {
      byChannel[row.channel] = {
        total: parseInt(row.total, 10),
        delivered: parseInt(row.delivered, 10),
        failed: parseInt(row.failed, 10),
      };
    }

    return {
      total: all,
      delivered,
      failed,
      retrying,
      successRate: all > 0 ? (delivered / all) * 100 : 0,
      byChannel,
    };
  }

  /**
   * Clear old delivery history (retention policy)
   * Default: keep 90 days of history
   */
  async cleanup(retentionDays: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.deliveryHistoryRepository.delete({
      createdAt: () => `created_at < '${cutoffDate.toISOString()}'`,
    });

    this.logger.log(`Deleted ${result.affected} old delivery history records`);
    return result.affected || 0;
  }
}
