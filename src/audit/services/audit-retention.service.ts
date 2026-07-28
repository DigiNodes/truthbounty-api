import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AuditTrailService } from './audit-trail.service';
import { AuditEventType } from '../entities/audit-log.entity';

@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);
  private readonly defaultDaysToKeep: number;
  private readonly retentionOverrides: Map<string, number> = new Map();

  constructor(
    private readonly auditTrailService: AuditTrailService,
    private readonly configService: ConfigService,
  ) {
    this.defaultDaysToKeep = this.resolveRetentionDays();
    this.loadRetentionOverrides();
  }

  @Cron(process.env.AUDIT_LOG_RETENTION_CRON || CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: 'audit-log-retention',
    timeZone: 'UTC',
  })
  async purgeOldAuditLogs(): Promise<number> {
    const deletedCount = await this.auditTrailService.deleteOldLogs(
      this.defaultDaysToKeep,
    );

    this.logger.log(
      `Audit retention job removed ${deletedCount} records older than ${this.defaultDaysToKeep} days`,
    );

    return deletedCount;
  }

  getRetentionDays(eventType?: AuditEventType): number {
    if (eventType && this.retentionOverrides.has(eventType)) {
      return this.retentionOverrides.get(eventType)!;
    }
    return this.defaultDaysToKeep;
  }

  getRetentionConfig(): {
    defaultDays: number;
    overrides: Record<string, number>;
  } {
    const overrides: Record<string, number> = {};
    this.retentionOverrides.forEach((days, eventType) => {
      overrides[eventType] = days;
    });
    return { defaultDays: this.defaultDaysToKeep, overrides };
  }

  private resolveRetentionDays(): number {
    const rawDays = this.configService.get<string>('AUDIT_LOG_RETENTION_DAYS');
    const parsedDays = parseInt(rawDays ?? '', 10);
    return Number.isNaN(parsedDays) || parsedDays <= 0 ? 365 : parsedDays;
  }

  private loadRetentionOverrides(): void {
    const raw = this.configService.get<string>('AUDIT_LOG_RETENTION_OVERRIDES');
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      for (const [eventType, days] of Object.entries(parsed)) {
        if (Object.values(AuditEventType).includes(eventType as AuditEventType) && typeof days === 'number') {
          this.retentionOverrides.set(eventType, days);
        }
      }
    } catch {
      this.logger.warn('Failed to parse AUDIT_LOG_RETENTION_OVERRIDES');
    }
  }
}
