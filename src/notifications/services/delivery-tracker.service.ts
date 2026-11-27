import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import {
  DeliveryChannel,
  DeliveryClaimContext,
  DeliveryStatus,
} from '../interfaces/notification.types';
import { RedisService } from '../../redis/redis.service';
import {
  acquireDeliveryClaim,
  confirmDeliveryClaim,
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_UNCERTAIN_CLAIM_TTL_MS,
  expireStaleDeliveryClaims,
  failDeliveryClaim,
  markDeliveryClaimUncertain,
  resolveDeliveryKey,
  retryDeliveryClaim,
} from '../delivery/delivery-claim';
import {
  deliveredCacheKey,
  deliveryClaimCacheKey,
} from '../delivery/delivery-idempotency-key';

const DEFAULT_DELIVERY_HISTORY_PAGE_SIZE = 50;
const MAX_DELIVERY_HISTORY_PAGE_SIZE = 100;

/**
 * DeliveryTracker
 *
 * Tracks notification delivery history and provides idempotency guards.
 *
 * The database row keyed by `idempotencyKey` is the correctness boundary. Redis
 * is only a cache of *confirmed* deliveries and a short-lived claim hint; a
 * Redis miss, outage or failed SETNX can never authorize a send by itself.
 */
@Injectable()
export class DeliveryTracker {
  private readonly logger = new Logger(DeliveryTracker.name);

  private readonly IDEMPOTENCY_TTL_SECONDS = 86400;

  /** Claim tokens for in-process calls; cross-worker fencing lives in the DB. */
  private readonly activeClaims = new Map<string, string>();

  constructor(
    @InjectRepository(DeliveryHistory)
    private deliveryHistoryRepository: Repository<DeliveryHistory>,
    private redisService: RedisService,
  ) {}

  /**
   * Acquire the durable claim for one notification-recipient-channel delivery.
   * Returns true only when this caller owns the claim and may call a provider.
   */
  async checkIdempotency(
    input: string | DeliveryClaimContext,
  ): Promise<boolean> {
    const context: DeliveryClaimContext =
      typeof input === 'string' ? { idempotencyKey: input } : input;
    const idempotencyKey = resolveDeliveryKey(context);

    if (await this.redisService.get(deliveredCacheKey(idempotencyKey))) {
      this.logger.debug(`Idempotency guard hit (Redis): ${idempotencyKey}`);
      return false;
    }

    const result = await acquireDeliveryClaim(
      this.deliveryHistoryRepository,
      context,
    );

    if (!result.acquired) {
      if (result.status === DeliveryStatus.DELIVERED) {
        await this.cacheConfirmedDelivery(idempotencyKey);
      }
      this.logger.debug(
        `Durable delivery claim not acquired (${result.reason}): ${idempotencyKey}`,
      );
      return false;
    }

    this.activeClaims.set(idempotencyKey, result.claimId!);
    const ttlSeconds = Math.max(
      1,
      Math.ceil((context.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS) / 1000),
    );

    // Optimization only. A false result (including Redis failure) is ignored
    // because the durable claim above has already been acquired.
    await this.redisService.setnx(
      deliveryClaimCacheKey(idempotencyKey),
      result.claimId!,
      ttlSeconds,
    );

    return true;
  }

  /** True when a durable DELIVERED record already exists for this key. */
  async isDelivered(input: string | DeliveryClaimContext): Promise<boolean> {
    const idempotencyKey = resolveDeliveryKey(
      typeof input === 'string' ? { idempotencyKey: input } : input,
    );

    if (await this.redisService.get(deliveredCacheKey(idempotencyKey))) {
      return true;
    }

    const history = await this.deliveryHistoryRepository.findOne({
      where: { idempotencyKey },
    });
    const delivered = history?.status === DeliveryStatus.DELIVERED;
    if (delivered) {
      await this.cacheConfirmedDelivery(idempotencyKey);
    }
    return delivered;
  }

  async expireStaleClaims(): Promise<number> {
    return expireStaleDeliveryClaims(this.deliveryHistoryRepository);
  }

  /**
   * Record a provider-confirmed delivery. Only the worker holding the fencing
   * token may settle the claim; repeated calls for a DELIVERED key are no-ops.
   */
  async recordDelivery(
    notificationId: string,
    userId: string,
    channel: DeliveryChannel,
    idempotencyKey: string,
    metadata?: Record<string, any>,
  ): Promise<DeliveryHistory> {
    const key = resolveDeliveryKey({
      idempotencyKey,
      notificationId,
      recipientId: userId,
      channel,
    });
    const claimId = this.activeClaims.get(key);
    const record = await confirmDeliveryClaim(
      this.deliveryHistoryRepository,
      key,
      claimId,
      metadata,
    );
    this.activeClaims.delete(key);
    await this.cacheConfirmedDelivery(key);
    await this.redisService.del(deliveryClaimCacheKey(key));
    return (
      record ??
      ({
        notificationId,
        recipientId: userId,
        channel,
        status: DeliveryStatus.DELIVERED,
        idempotencyKey,
        deliveredAt: new Date(),
        metadata,
      } as DeliveryHistory)
    );
  }

  /**
   * Record a definite (non-duplicate) provider failure and release the claim so
   * the shared retry policy may re-acquire it.
   */
  async recordFailure(
    notificationId: string,
    channel: DeliveryChannel,
    failureReason: string,
    idempotencyKey?: string,
    retryAttempts: number = 0,
    metadataOrUserId?: Record<string, any> | string,
  ): Promise<DeliveryHistory> {
    const metadata =
      typeof metadataOrUserId === 'string' ? undefined : metadataOrUserId;
    const recipientId =
      typeof metadataOrUserId === 'string' ? metadataOrUserId : undefined;
    const key = resolveDeliveryKey({
      idempotencyKey,
      notificationId,
      recipientId,
      channel,
    });
    const claimId = this.activeClaims.get(key);

    const record = metadata?.terminal
      ? await failDeliveryClaim(
          this.deliveryHistoryRepository,
          key,
          claimId,
          failureReason,
          true,
        )
      : await failDeliveryClaim(
          this.deliveryHistoryRepository,
          key,
          claimId,
          failureReason,
        );

    this.activeClaims.delete(key);
    await this.redisService.del(deliveryClaimCacheKey(key));

    return (
      record ??
      ({
        notificationId,
        recipientId,
        channel,
        status: DeliveryStatus.FAILED,
        failureReason,
        retryAttempts,
        idempotencyKey,
        metadata,
      } as DeliveryHistory)
    );
  }

  /** Record that another retry has been scheduled for this delivery. */
  async recordRetry(
    notificationId: string,
    channel: DeliveryChannel,
    retryAttempt: number,
    idempotencyKey?: string,
    metadata?: Record<string, any>,
  ): Promise<DeliveryHistory> {
    const key = resolveDeliveryKey({ idempotencyKey, notificationId, channel });
    const claimId = this.activeClaims.get(key);
    const record = await retryDeliveryClaim(
      this.deliveryHistoryRepository,
      key,
      claimId,
      retryAttempt,
      metadata?.failureReason,
    );
    this.activeClaims.delete(key);
    await this.redisService.del(deliveryClaimCacheKey(key));
    return (
      record ??
      ({
        notificationId,
        channel,
        status: DeliveryStatus.RETRYING,
        retryAttempts: retryAttempt,
        lastRetryAt: new Date(),
        idempotencyKey,
        metadata,
      } as DeliveryHistory)
    );
  }

  /**
   * The provider may have accepted the delivery but the worker cannot prove it.
   * Keep the row PROCESSING with a longer lease and require idempotent recovery
   * instead of an immediate resend.
   */
  async markProviderOutcomeUncertain(
    notificationId: string,
    channel: DeliveryChannel,
    idempotencyKey: string,
    reason: string,
  ): Promise<DeliveryHistory | null> {
    const key = resolveDeliveryKey({ idempotencyKey, notificationId, channel });
    const claimId = this.activeClaims.get(key);
    const record = await markDeliveryClaimUncertain(
      this.deliveryHistoryRepository,
      key,
      claimId,
      reason,
      DEFAULT_UNCERTAIN_CLAIM_TTL_MS,
    );
    this.activeClaims.delete(key);
    await this.redisService.del(deliveryClaimCacheKey(key));
    return record;
  }

  private async cacheConfirmedDelivery(idempotencyKey: string): Promise<void> {
    await this.redisService.set(
      deliveredCacheKey(idempotencyKey),
      '1',
      this.IDEMPOTENCY_TTL_SECONDS,
    );
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
    take: number = DEFAULT_DELIVERY_HISTORY_PAGE_SIZE,
  ): Promise<{ items: DeliveryHistory[]; total: number }> {
    const [items, total] = await this.deliveryHistoryRepository.findAndCount({
      where: { recipientId: userId },
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
    byChannel: Record<
      DeliveryChannel,
      { total: number; delivered: number; failed: number }
    >;
  }> {
    const query = this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .where('dh.createdAt BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      });

    if (channel) {
      query.andWhere('dh.channel = :channel', { channel });
    }

    const [all, delivered, failed, retrying] = await Promise.all([
      query.getCount(),
      query
        .clone()
        .andWhere('dh.status = :status', { status: DeliveryStatus.DELIVERED })
        .getCount(),
      query
        .clone()
        .andWhere('dh.status = :status', { status: DeliveryStatus.FAILED })
        .getCount(),
      query
        .clone()
        .andWhere('dh.status = :status', { status: DeliveryStatus.RETRYING })
        .getCount(),
    ]);

    const byChannelResult = await this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .select('dh.channel', 'channel')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        "SUM(CASE WHEN dh.status = 'delivered' THEN 1 ELSE 0 END)",
        'delivered',
      )
      .addSelect(
        "SUM(CASE WHEN dh.status = 'failed' THEN 1 ELSE 0 END)",
        'failed',
      )
      .where('dh.createdAt BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      })
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
   * Get provider-confirmed deliveries for audit purposes
   * 
   * Returns all deliveries that have been confirmed by the provider with a
   * message ID. These deliveries have the strongest evidence of completion.
   */
  async getProviderConfirmedDeliveries(
    startDate: Date,
    endDate: Date,
    channel?: DeliveryChannel,
  ): Promise<DeliveryHistory[]> {
    const query = this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .where('dh.status = :status', { status: 'delivered' })
      .andWhere('dh.deliveredAt BETWEEN :start AND :end', { start: startDate, end: endDate })
      .andWhere("dh.metadata->>'providerConfirmed' = 'true'")
      .orderBy('dh.deliveredAt', 'DESC');

    if (channel) {
      query.andWhere('dh.channel = :channel', { channel });
    }

    return query.getMany();
  }

  /**
   * Check if a delivery is provider-confirmed by idempotency key
   */
  async isProviderConfirmed(idempotencyKey: string): Promise<boolean> {
    const history = await this.deliveryHistoryRepository.findOne({
      where: { idempotencyKey },
    });

    return (
      history !== null &&
      history.status === 'delivered' &&
      history.metadata?.providerConfirmed === true &&
      history.metadata?.providerMessageId !== undefined
    );
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