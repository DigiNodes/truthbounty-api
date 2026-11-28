import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import {
  AuditActionType,
  AuditCategory,
  AuditEntityType,
  AuditSeverity,
} from '../../audit/entities/audit-log.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import {
  EventQuarantine,
  QuarantineStatus,
} from './entities/event-quarantine.entity';
import { GracefulShutdownService } from '../../common/lifecycle/graceful-shutdown.service';

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Retention for replayed quarantine rows (PREWAVE-BE-053, #647).
 *
 * Only rows with terminal replay state (`replayed`) past their `retentionUntil`
 * are eligible. `open` rows are NEVER deleted: removing them would silently
 * unblock readiness and discard unprocessed logs.
 */
@Injectable()
export class EventQuarantineRetentionService {
  private readonly logger = new Logger(EventQuarantineRetentionService.name);

  constructor(
    @InjectRepository(EventQuarantine)
    private readonly repo: Repository<EventQuarantine>,
    private readonly config: ConfigService,
    private readonly gracefulShutdown: GracefulShutdownService,
    @Optional() private readonly audit?: AuditTrailService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduledCleanup(): Promise<void> {
    if (this.gracefulShutdown.isDraining) return;
    try {
      await this.gracefulShutdown.runTracked('event-quarantine-retention', () =>
        this.runRetentionCleanup(),
      );
    } catch (error) {
      this.logger.error(
        `Scheduled quarantine retention failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Delete replayed quarantine rows whose retention window has elapsed.
   * Returns the number of rows removed. Idempotent.
   */
  async runRetentionCleanup(now: Date = new Date()): Promise<number> {
    const days = this.retentionDays();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const result = await this.repo.delete({
      status: QuarantineStatus.REPLAYED,
      retentionUntil: LessThanOrEqual(cutoff),
    });
    const removed = result.affected ?? 0;

    if (removed > 0) {
      this.logger.log(
        `Quarantine retention removed ${removed} replayed row(s) older than ${cutoff.toISOString()}`,
      );
    }

    await this.audit?.log({
      actionType: AuditActionType.EVENT_QUARANTINE_RETENTION,
      entityType: AuditEntityType.EVENT_QUARANTINE,
      entityId: 'retention',
      severity: AuditSeverity.LOW,
      category: AuditCategory.OPERATIONS,
      description: `Quarantine retention removed ${removed} replayed row(s)`,
      metadata: { removed, retentionDays: days, cutoff: cutoff.toISOString() },
    });

    return removed;
  }

  private retentionDays(): number {
    const raw = this.config.get<string | number>(
      'EVENT_QUARANTINE_RETENTION_DAYS',
      DEFAULT_RETENTION_DAYS,
    );
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
      return DEFAULT_RETENTION_DAYS;
    }
    return Math.floor(days);
  }
}