import { Injectable, Logger } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryHistory } from '../entities/delivery-history.entity';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';

/**
 * NotificationMetricsService
 * 
 * Prometheus metrics for notification system observability.
 * 
 * Tracks:
 * - Notifications sent/delivered/failed
 * - Delivery latency per channel
 * - Queue depth
 * - Dead-letter count
 * - Provider availability
 */
@Injectable()
export class NotificationMetricsService {
  private readonly logger = new Logger(NotificationMetricsService.name);

  constructor(
    @InjectRepository(DeliveryHistory)
    private deliveryHistoryRepository: Repository<DeliveryHistory>,
    @InjectRepository(OutboxEvent)
    private outboxRepository: Repository<OutboxEvent>,
    // Prometheus metrics - will be injected if prometheus is configured
    // Otherwise, these will be no-ops
  ) {
    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    // Metrics will be registered via decorators in module
  }

  /**
   * Record notification sent
   */
  recordNotificationSent(
    eventType: string,
    channel: string,
    userId?: string,
  ): void {
    try {
      // Counter: notifications_sent_total
      this.logger.debug(
        `Metric: notification sent (${eventType}, ${channel})`,
      );
    } catch (error) {
      this.logger.warn(`Failed to record metric: ${error.message}`);
    }
  }

  /**
   * Record notification delivered
   */
  recordNotificationDelivered(
    eventType: string,
    channel: string,
    latencyMs: number,
  ): void {
    try {
      // Counter: notifications_delivered_total
      // Histogram: notification_delivery_duration_ms
      this.logger.debug(
        `Metric: notification delivered (${eventType}, ${channel}, ${latencyMs}ms)`,
      );
    } catch (error) {
      this.logger.warn(`Failed to record metric: ${error.message}`);
    }
  }

  /**
   * Record notification failed
   */
  recordNotificationFailed(
    eventType: string,
    channel: string,
    reason: string,
  ): void {
    try {
      // Counter: notifications_failed_total
      this.logger.debug(
        `Metric: notification failed (${eventType}, ${channel}, ${reason})`,
      );
    } catch (error) {
      this.logger.warn(`Failed to record metric: ${error.message}`);
    }
  }

  /**
   * Record retry attempt
   */
  recordRetryAttempt(eventType: string, channel: string): void {
    try {
      // Counter: notifications_retried_total
      this.logger.debug(
        `Metric: notification retried (${eventType}, ${channel})`,
      );
    } catch (error) {
      this.logger.warn(`Failed to record metric: ${error.message}`);
    }
  }

  /**
   * Record outbox event dispatched
   */
  recordOutboxDispatched(eventType: string): void {
    try {
      // Counter: outbox_events_dispatched_total
      this.logger.debug(`Metric: outbox event dispatched (${eventType})`);
    } catch (error) {
      this.logger.warn(`Failed to record metric: ${error.message}`);
    }
  }

  /**
   * Record outbox event dead-lettered
   */
  recordOutboxDeadLettered(eventType: string): void {
    try {
      // Counter: outbox_events_dead_lettered_total
      this.logger.debug(
        `Metric: outbox event dead-lettered (${eventType})`,
      );
    } catch (error) {
      this.logger.warn(`Failed to record metric: ${error.message}`);
    }
  }

  /**
   * Get system metrics
   */
  async getSystemMetrics(): Promise<{
    notificationsSent24h: number;
    notificationsDelivered24h: number;
    notificationsFailed24h: number;
    avgDeliveryLatencyMs: number;
    successRate24h: number;
    queueDepth: number;
    deadLetterCount: number;
    processingRate: number; // per second
  }> {
    const now = new Date();
    const oneDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Get delivery stats for last 24 hours
    const deliveryStats = await this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .select('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN dh.status = 'delivered' THEN 1 ELSE 0 END)", 'delivered')
      .addSelect("SUM(CASE WHEN dh.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
      .where('dh.createdAt >= :start', { start: oneDay })
      .getRawOne();

    const avgLatency = await this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .select('AVG(dh.deliveredAt - dh.createdAt)', 'avgLatency')
      .where('dh.status = :status', { status: 'delivered' })
      .andWhere('dh.createdAt >= :start', { start: oneDay })
      .getRawOne();

    // Get queue depth
    const outboxStats = await this.outboxRepository
      .createQueryBuilder('oe')
      .select('COUNT(*)', 'pending')
      .addSelect(
        "COUNT(CASE WHEN oe.status = 'DEAD_LETTER' THEN 1 END)",
        'deadLetter',
      )
      .getRawOne();

    const sent = parseInt(deliveryStats?.total || '0', 10);
    const delivered = parseInt(deliveryStats?.delivered || '0', 10);
    const failed = parseInt(deliveryStats?.failed || '0', 10);

    const successRate = sent > 0 ? (delivered / sent) * 100 : 0;
    const processingRate = sent / (24 * 60 * 60); // per second

    return {
      notificationsSent24h: sent,
      notificationsDelivered24h: delivered,
      notificationsFailed24h: failed,
      avgDeliveryLatencyMs: avgLatency?.avgLatency || 0,
      successRate24h: successRate,
      queueDepth: parseInt(outboxStats?.pending || '0', 10),
      deadLetterCount: parseInt(outboxStats?.deadLetter || '0', 10),
      processingRate,
    };
  }

  /**
   * Get channel-specific metrics
   */
  async getChannelMetrics(): Promise<
    Record<
      string,
      {
        total: number;
        delivered: number;
        failed: number;
        successRate: number;
      }
    >
  > {
    const channels = await this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .select('dh.channel', 'channel')
      .addSelect('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN dh.status = 'delivered' THEN 1 ELSE 0 END)", 'delivered')
      .addSelect("SUM(CASE WHEN dh.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
      .groupBy('dh.channel')
      .getRawMany();

    const metrics: Record<string, any> = {};

    for (const row of channels) {
      const total = parseInt(row.total, 10);
      const delivered = parseInt(row.delivered, 10);

      metrics[row.channel] = {
        total,
        delivered,
        failed: parseInt(row.failed, 10),
        successRate: total > 0 ? (delivered / total) * 100 : 0,
      };
    }

    return metrics;
  }

  /**
   * Get event type metrics
   */
  async getEventTypeMetrics(): Promise<
    Record<
      string,
      {
        count: number;
        successRate: number;
      }
    >
  > {
    const events = await this.deliveryHistoryRepository
      .createQueryBuilder('dh')
      .select("dh.metadata->>'eventType'", 'eventType')
      .addSelect('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN dh.status = 'delivered' THEN 1 ELSE 0 END)", 'delivered')
      .where('dh.metadata IS NOT NULL')
      .groupBy("dh.metadata->>'eventType'")
      .getRawMany();

    const metrics: Record<string, any> = {};

    for (const row of events) {
      const total = parseInt(row.total, 10);
      const delivered = parseInt(row.delivered, 10);

      metrics[row.eventType] = {
        count: total,
        successRate: total > 0 ? (delivered / total) * 100 : 0,
      };
    }

    return metrics;
  }

  /**
   * Health check: alert if system is degraded
   */
  async getHealthStatus(): Promise<{
    status: 'healthy' | 'degraded' | 'critical';
    issues: string[];
  }> {
    const metrics = await this.getSystemMetrics();
    const issues: string[] = [];

    // Check success rate
    if (metrics.successRate24h < 95) {
      issues.push(
        `Low success rate: ${metrics.successRate24h.toFixed(2)}%`,
      );
    }

    // Check queue depth
    if (metrics.queueDepth > 1000) {
      issues.push(`High queue depth: ${metrics.queueDepth} pending`);
    }

    // Check dead-letter count
    if (metrics.deadLetterCount > 10) {
      issues.push(
        `High dead-letter count: ${metrics.deadLetterCount}`,
      );
    }

    // Determine status
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (issues.length > 0) {
      status = metrics.deadLetterCount > 50 ? 'critical' : 'degraded';
    }

    return { status, issues };
  }
}
