import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';

@Injectable()
export class AuditMetricsService {
  private readonly logger = new Logger(AuditMetricsService.name);

  private metrics = {
    eventsGenerated: 0,
    failedWrites: 0,
    searchOperations: 0,
    searchLatencyMs: 0,
    exportRequests: 0,
    integrityChecks: 0,
    integrityFailures: 0,
    storageUtilizationBytes: 0,
    lastCalculatedStorage: Date.now(),
  };

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  incrementEventsGenerated(): void {
    this.metrics.eventsGenerated++;
  }

  incrementFailedWrites(): void {
    this.metrics.failedWrites++;
  }

  recordSearchOperation(latencyMs: number): void {
    this.metrics.searchOperations++;
    this.metrics.searchLatencyMs = latencyMs;
  }

  incrementExportRequests(): void {
    this.metrics.exportRequests++;
  }

  recordIntegrityCheck(passed: boolean): void {
    this.metrics.integrityChecks++;
    if (!passed) {
      this.metrics.integrityFailures++;
    }
  }

  async getMetrics(): Promise<{
    eventsGenerated: number;
    failedWrites: number;
    searchOperations: number;
    averageSearchLatencyMs: number;
    exportRequests: number;
    integrityChecks: number;
    integrityFailures: number;
    integrityHealthPercent: number;
    storageUtilizationBytes: number;
    totalRecords: number;
    recordsByEventType: Record<string, number>;
    recordsBySeverity: Record<string, number>;
  }> {
    const totalRecords = await this.auditLogRepo.count();
    const avgLatency = this.metrics.searchOperations > 0
      ? Math.round(this.metrics.searchLatencyMs / this.metrics.searchOperations)
      : 0;
    const integrityHealth = this.metrics.integrityChecks > 0
      ? Math.round(((this.metrics.integrityChecks - this.metrics.integrityFailures) / this.metrics.integrityChecks) * 100)
      : 100;

    const eventTypeCounts = await this.auditLogRepo
      .createQueryBuilder('audit')
      .select('audit.eventType', 'eventType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.eventType')
      .getRawMany();

    const severityCounts = await this.auditLogRepo
      .createQueryBuilder('audit')
      .select('audit.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.severity')
      .getRawMany();

    const recordsByEventType: Record<string, number> = {};
    eventTypeCounts.forEach((r: any) => {
      recordsByEventType[r.eventType || 'UNKNOWN'] = parseInt(r.count, 10);
    });

    const recordsBySeverity: Record<string, number> = {};
    severityCounts.forEach((r: any) => {
      recordsBySeverity[r.severity || 'UNKNOWN'] = parseInt(r.count, 10);
    });

    const recordSize = 1024;
    const storageUtilizationBytes = totalRecords * recordSize;

    return {
      eventsGenerated: this.metrics.eventsGenerated,
      failedWrites: this.metrics.failedWrites,
      searchOperations: this.metrics.searchOperations,
      averageSearchLatencyMs: avgLatency,
      exportRequests: this.metrics.exportRequests,
      integrityChecks: this.metrics.integrityChecks,
      integrityFailures: this.metrics.integrityFailures,
      integrityHealthPercent: integrityHealth,
      storageUtilizationBytes,
      totalRecords,
      recordsByEventType,
      recordsBySeverity,
    };
  }
}
