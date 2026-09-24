import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AuditTrailService } from './audit-trail.service';

@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);
  private readonly daysToKeep: number;

  constructor(
    private readonly auditTrailService: AuditTrailService,
    private readonly configService: ConfigService,
  ) {
    this.daysToKeep = this.resolveRetentionDays();
  }

  @Cron(process.env.AUDIT_LOG_RETENTION_CRON || CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: 'audit-log-retention',
    timeZone: 'UTC',
  })
  async purgeOldAuditLogs(): Promise<number> {
    const deletedCount = await this.auditTrailService.deleteOldLogs(
      this.daysToKeep,
    );

    this.logger.log(
      `Audit retention job removed ${deletedCount} records older than ${this.daysToKeep} days`,
    );

    return deletedCount;
  }

  private resolveRetentionDays(): number {
    const rawDays = this.configService.get<string>('AUDIT_LOG_RETENTION_DAYS');
    const parsedDays = parseInt(rawDays ?? '', 10);
    return Number.isNaN(parsedDays) || parsedDays <= 0 ? 365 : parsedDays;
  }
}
