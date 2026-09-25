import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AuditTrailService } from './audit-trail.service';

export interface RetentionExecutionResult {
  purgedLogsCount: number;
  scrubbedPiiCount: number;
  retentionDays: number;
  piiRetentionDays: number;
  timestamp: string;
}

@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);
  private readonly daysToKeep: number;
  private readonly piiDaysToKeep: number;

  constructor(
    private readonly auditTrailService: AuditTrailService,
    private readonly configService: ConfigService,
  ) {
    this.daysToKeep = this.resolveRetentionDays();
    this.piiDaysToKeep = this.resolvePiiRetentionDays();
  }

  @Cron(process.env.AUDIT_LOG_RETENTION_CRON || CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: 'audit-log-retention',
    timeZone: 'UTC',
  })
  async enforceRetentionAndPrivacyPolicies(): Promise<RetentionExecutionResult> {
    this.logger.log('Starting scheduled data retention and privacy controls execution');

    const purgedLogsCount = await this.purgeOldAuditLogs();
    const scrubbedPiiCount = await this.scrubOldPii();

    const result: RetentionExecutionResult = {
      purgedLogsCount,
      scrubbedPiiCount,
      retentionDays: this.daysToKeep,
      piiRetentionDays: this.piiDaysToKeep,
      timestamp: new Date().toISOString(),
    };

    this.logger.log(
      `Retention and privacy execution complete: purged ${purgedLogsCount} expired records, scrubbed PII from ${scrubbedPiiCount} records`,
    );

    return result;
  }

  async purgeOldAuditLogs(): Promise<number> {
    const deletedCount = await this.auditTrailService.deleteOldLogs(
      this.daysToKeep,
    );

    this.logger.log(
      `Audit retention job removed ${deletedCount} records older than ${this.daysToKeep} days`,
    );

    return deletedCount;
  }

  async scrubOldPii(): Promise<number> {
    const scrubbedCount = await this.auditTrailService.scrubAgedPii(
      this.piiDaysToKeep,
    );

    this.logger.log(
      `Privacy controls scrubbed PII from ${scrubbedCount} records older than ${this.piiDaysToKeep} days`,
    );

    return scrubbedCount;
  }

  private resolveRetentionDays(): number {
    const rawDays = this.configService.get<string>('AUDIT_LOG_RETENTION_DAYS');
    const parsedDays = parseInt(rawDays ?? '', 10);
    return Number.isNaN(parsedDays) || parsedDays <= 0 ? 365 : parsedDays;
  }

  private resolvePiiRetentionDays(): number {
    const rawDays = this.configService.get<string>('AUDIT_PII_RETENTION_DAYS');
    const parsedDays = parseInt(rawDays ?? '', 10);
    return Number.isNaN(parsedDays) || parsedDays <= 0 ? 30 : parsedDays;
  }
}
