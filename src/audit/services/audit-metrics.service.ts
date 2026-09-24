import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';
import * as client from 'prom-client';

@Injectable()
export class AuditMetricsService implements OnModuleInit {
  private readonly logger = new Logger(AuditMetricsService.name);

  private auditEventsTotal: client.Counter<string>;
  private auditEventsByAction: client.Counter<string>;
  private auditEventsBySeverity: client.Counter<string>;
  private auditEventsByCategory: client.Counter<string>;
  private auditWriteDuration: client.Histogram<string>;
  private auditSearchDuration: client.Histogram<string>;
  private auditStorageSize: client.Gauge<string>;
  private auditOldestRecord: client.Gauge<string>;
  private auditFailedWrites: client.Counter<string>;
  private auditExportOperations: client.Counter<string>;
  private auditRetentionOperations: client.Counter<string>;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  onModuleInit(): void {
    const prefix = 'audit_';

    this.auditEventsTotal = new client.Counter({
      name: `${prefix}events_total`,
      help: 'Total number of audit events recorded',
    });

    this.auditEventsByAction = new client.Counter({
      name: `${prefix}events_by_action_total`,
      help: 'Audit events by action type',
      labelNames: ['action'],
    });

    this.auditEventsBySeverity = new client.Counter({
      name: `${prefix}events_by_severity_total`,
      help: 'Audit events by severity',
      labelNames: ['severity'],
    });

    this.auditEventsByCategory = new client.Counter({
      name: `${prefix}events_by_category_total`,
      help: 'Audit events by category',
      labelNames: ['category'],
    });

    this.auditWriteDuration = new client.Histogram({
      name: `${prefix}write_duration_seconds`,
      help: 'Duration of audit log write operations',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    });

    this.auditSearchDuration = new client.Histogram({
      name: `${prefix}search_duration_seconds`,
      help: 'Duration of audit search operations',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    });

    this.auditStorageSize = new client.Gauge({
      name: `${prefix}storage_records_total`,
      help: 'Total number of audit log records in storage',
    });

    this.auditOldestRecord = new client.Gauge({
      name: `${prefix}oldest_record_age_days`,
      help: 'Age in days of the oldest audit record',
    });

    this.auditFailedWrites = new client.Counter({
      name: `${prefix}failed_writes_total`,
      help: 'Total number of failed audit write operations',
    });

    this.auditExportOperations = new client.Counter({
      name: `${prefix}export_operations_total`,
      help: 'Total number of audit export operations',
    });

    this.auditRetentionOperations = new client.Counter({
      name: `${prefix}retention_operations_total`,
      help: 'Total number of audit retention operations',
    });
  }

  incrementWrite(action: string, severity: string, category: string): void {
    this.auditEventsTotal.inc();
    this.auditEventsByAction.inc({ action });
    this.auditEventsBySeverity.inc({ severity });
    this.auditEventsByCategory.inc({ category });
  }

  observeWriteDuration(seconds: number): void {
    this.auditWriteDuration.observe(seconds);
  }

  observeSearchDuration(seconds: number): void {
    this.auditSearchDuration.observe(seconds);
  }

  incrementFailedWrite(): void {
    this.auditFailedWrites.inc();
  }

  incrementExport(): void {
    this.auditExportOperations.inc();
  }

  incrementRetention(): void {
    this.auditRetentionOperations.inc();
  }

  async updateStorageMetrics(): Promise<void> {
    try {
      const totalRecords = await this.auditLogRepo.count();
      this.auditStorageSize.set(totalRecords);

      const oldest = await this.auditLogRepo
        .createQueryBuilder('audit')
        .orderBy('audit.createdAt', 'ASC')
        .getOne();

      if (oldest) {
        const ageDays = (Date.now() - oldest.createdAt.getTime()) / (1000 * 60 * 60 * 24);
        this.auditOldestRecord.set(ageDays);
      }
    } catch (error) {
      this.logger.error(`Failed to update storage metrics: ${error.message}`);
    }
  }

  getMetrics(): Promise<string> {
    return client.register.metrics();
  }
}
