import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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

/** Terminal statuses eligible for retention cleanup. */
const TERMINAL_STATUSES: NotificationStatus[] = [
  NotificationStatus.DELIVERED,
  NotificationStatus.READ,
  NotificationStatus.DISMISSED,
  NotificationStatus.FAILED,
];

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
   * windows. Operates only on terminal records so in-flight deliveries are never
   * removed out from under the processor.
   *
   * Delivery rows are deleted first so foreign-key constraints are not violated.
   */
  async runRetentionCleanup(
    notificationRetentionDays = DEFAULT_NOTIFICATION_RETENTION_DAYS,
    deliveryRetentionDays = DEFAULT_DELIVERY_RETENTION_DAYS,
  ): Promise<RetentionResult> {
    this.assertPositiveDays('notificationRetentionDays', notificationRetentionDays);
    this.assertPositiveDays('deliveryRetentionDays', deliveryRetentionDays);

    const notificationCutoff = this.cutoffDate(notificationRetentionDays);
    const deliveryCutoff = this.cutoffDate(deliveryRetentionDays);

    // Delivery rows first (FK dependency)
    const deliveriesDeleted = await this.purgeDeliveries(deliveryCutoff);
    const notificationsDeleted = await this.purgeNotifications(notificationCutoff);

    this.logger.log(
      `Retention cleanup completed: ${notificationsDeleted} notifications, ` +
        `${deliveriesDeleted} deliveries purged. ` +
        `Notification cutoff=${notificationCutoff.toISOString()}, ` +
        `delivery cutoff=${deliveryCutoff.toISOString()}.`,
    );

    return { notificationsDeleted, deliveriesDeleted };
  }

  private async purgeDeliveries(cutoff: Date): Promise<number> {
    const result = await this.deliveryHistoryRepository.delete({
      createdAt: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }

  private async purgeNotifications(cutoff: Date): Promise<number> {
    // Only terminal notifications are eligible for retention cleanup; queued or
    // in-flight records must not be deleted out from under the processor.
    const result = await this.notificationRepository.delete({
      createdAt: LessThan(cutoff),
      status: In(TERMINAL_STATUSES),
    });
    return result.affected ?? 0;
  }

  /** Returns a Date that is exactly `days` calendar days before now (UTC). */
  private cutoffDate(days: number): Date {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    return cutoff;
  }

  private assertPositiveDays(label: string, days: number): void {
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(
        `${label} must be a positive finite number, received: ${days}`,
      );
    }
  }
}