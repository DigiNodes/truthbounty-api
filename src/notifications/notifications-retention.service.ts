import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeiorm';
import { In, LessThan, Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { DeliveryHistory } from './entities/delivery-history.entity';
import { NotificationStatus } from './enums/notification-status.enum';

export interface RetentionResult {
  notificationsDeleted: number;
  deliveriesDeleted: number;
}

export const DEFAULT_NOTIFICATION_RETENTION_DAYS = 90 as number;
export const DEFAULT_DELIVERY_RETENTION_DAYS = 180 as number;

@Injectable()
export class NotificationsRetentionService {
  private readonly logger = new Logger(NotificationsRetentionService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(DeliveryHistory)
    private readonly deliveryHistoryRepository: Repository<DeliveryHistory>,
  ) {}

  /**
   * Purge notifications and delivery history older than the configured retention
   * windows. Uses TypeORM operators (LessThan) so the predicates compile and execute
   * on the production PostgreSQL driver and remain indexable on the createdAt column.
   */
  async runRetentionCleanup(
    notificationRetentionDays = DEFAULT_NOTIFICATION_RETENTION_DAYS,
    deliveryRetentionDays = DEFAULT_DELIVERY_RETENTION_DAYS,
  ): Promise<RetentionResult> {
    this.assertPositiveDays('notificationRetentionDays', notificationRetentionDays);
    this.assertPositiveDays('deliveryRetentionDays', deliveryRetentionDays);

    const notificationCutoff = this.cutoffDate(notificationRetentionDays);
    const deliveryCutoff = this.cutoffDate(deliveryRetentionDays);

    const deliveriesDeleted = await this.purgeDeliveries(deliveryCutoff);
    const notificationsDeleted = await this.purgeNotifications(notificationCutoff);

    this.logger.log(
      `Retention cleanup completed: ${notificationsDeleted} notifications, ${deliveriesDeleted} deliveries purged. ` +
        `Notification cutoff=${notificationCutoff.toISOString()}, delivery cutoff=${deliveryCutoff.toISOString()}.`,
    );

    return { notificationsDeleted, deliveriesDeleted };
  }

  private async purgeDeliveries(cutoff: Date): Promise<number> {
    const result = await this.deliveryHistoryRepository.delete({
      attemptedAt: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }

  private async purgeNotifications(cutoff: Date): Promise<number> {
    // Only terminal notifications are eligible for retention cleanup; queued or
    // in-flight records must not be deleted out from under the processor.
    const result = await this.notificationRepository.delete({
      createdAt: LessThan(cutoff),
      status: In(
        NotificationStatus.DELIVERED,
        NotificationStatus.READ,
        NotificationStatus.DISMISSED,
        NotificationStatus.FAILED,
      ),
    });
    return result.affected ?? 0;
  }

  private cutoffDate(days: number): Date {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days * 24 * 60 * 60 * 1000);
    return cutoff;
  }

  private assertPositiveDays(label: string, days: number): void {
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`${label} must be a positive finite number, received: ${days}`);
    }
  }
}
