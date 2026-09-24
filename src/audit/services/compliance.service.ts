import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditLog,
  AuditActionType,
  AuditEntityType,
  AuditSeverity,
  AuditCategory,
} from '../entities/audit-log.entity';
import { ComplianceReport } from '../interfaces/audit-response.interface';
import { randomUUID } from 'crypto';

export interface ReportOptions {
  type?: string;
  startDate?: string;
  endDate?: string;
  userId?: string;
  format?: 'json' | 'csv';
}

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  async generateReport(options: ReportOptions): Promise<ComplianceReport> {
    const type = options.type || 'audit-summary';
    const startDate = options.startDate
      ? new Date(options.startDate)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = options.endDate ? new Date(options.endDate) : new Date();
    const format = options.format || 'json';

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC');

    if (options.userId) {
      query.andWhere('audit.userId = :userId', { userId: options.userId });
    }

    switch (type) {
      case 'admin-activity':
        query.andWhere('audit.category = :cat', { cat: AuditCategory.ADMINISTRATIVE });
        break;
      case 'moderation-actions':
        query.andWhere('audit.category = :cat', { cat: AuditCategory.MODERATION });
        break;
      case 'login-history':
        query.andWhere('(audit.actionType = :s OR audit.actionType = :f)', {
          s: AuditActionType.LOGIN_SUCCESS,
          f: AuditActionType.LOGIN_FAILED,
        });
        break;
      case 'governance-actions':
        query.andWhere('audit.category = :cat', { cat: AuditCategory.GOVERNANCE });
        break;
      case 'permission-changes':
        query.andWhere('(audit.actionType = :pc OR audit.actionType = :ra OR audit.actionType = :rr)', {
          pc: AuditActionType.PERMISSION_CHANGED,
          ra: AuditActionType.ROLE_ASSIGNED,
          rr: AuditActionType.ROLE_REVOKED,
        });
        break;
      case 'security-incidents':
        query.andWhere('audit.severity IN (:...severities)', {
          severities: [AuditSeverity.HIGH, AuditSeverity.CRITICAL],
        });
        break;
    }

    const records = await query.getMany();
    const summary = this.buildSummary(records);

    const report: ComplianceReport = {
      id: randomUUID(),
      type,
      title: this.getReportTitle(type),
      generatedAt: new Date().toISOString(),
      generatedBy: 'system',
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      summary,
      records: format === 'csv' ? this.toCsvRecords(records) : records,
      totalRecords: records.length,
    };

    return report;
  }

  async exportAuditLogs(options: ReportOptions): Promise<{ data: any; format: string; filename: string }> {
    const startDate = options.startDate
      ? new Date(options.startDate)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = options.endDate ? new Date(options.endDate) : new Date();
    const format = options.format || 'json';

    const records = await this.auditLogRepo.find({
      where: {
        createdAt: this.buildDateRangeCondition(startDate, endDate) as any,
      },
      order: { createdAt: 'DESC' },
      relations: ['user'],
    });

    const filename = `audit-export-${startDate.toISOString().split('T')[0]}-to-${endDate.toISOString().split('T')[0]}`;

    if (format === 'csv') {
      return {
        data: this.toCsvString(records),
        format: 'text/csv',
        filename: `${filename}.csv`,
      };
    }

    return {
      data: records,
      format: 'application/json',
      filename: `${filename}.json`,
    };
  }

  private buildDateRangeCondition(start: Date, end: Date) {
    return { start, end };
  }

  private buildSummary(records: AuditLog[]): Record<string, number> {
    const summary: Record<string, number> = {
      total: records.length,
    };

    records.forEach((record) => {
      const actionKey = `action:${record.actionType}`;
      summary[actionKey] = (summary[actionKey] || 0) + 1;

      const severityKey = `severity:${record.severity}`;
      summary[severityKey] = (summary[severityKey] || 0) + 1;
    });

    return summary;
  }

  private getReportTitle(type: string): string {
    const titles: Record<string, string> = {
      'admin-activity': 'Administrator Activity Report',
      'moderation-actions': 'Moderation Actions Report',
      'login-history': 'Login History Report',
      'governance-actions': 'Governance Actions Report',
      'permission-changes': 'Permission Changes Report',
      'security-incidents': 'Security Incidents Report',
      'audit-summary': 'Audit Summary Report',
    };
    return titles[type] || 'Compliance Report';
  }

  private toCsvRecords(records: AuditLog[]): any[] {
    return records.map((r) => ({
      eventId: r.eventId,
      actionType: r.actionType,
      entityType: r.entityType,
      entityId: r.entityId,
      userId: r.userId,
      severity: r.severity,
      category: r.category,
      description: r.description,
      createdAt: r.createdAt?.toISOString(),
      ipAddress: r.ipAddress,
      source: r.source,
      requestId: r.requestId,
    }));
  }

  private toCsvString(records: AuditLog[]): string {
    const headers = ['eventId', 'actionType', 'entityType', 'entityId', 'userId', 'severity', 'category', 'description', 'createdAt', 'ipAddress', 'source', 'requestId'];
    const rows = this.toCsvRecords(records);

    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(',')),
    ];

    return lines.join('\n');
  }

  async getCategorySummary(days = 30): Promise<Record<string, number>> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .select('audit.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('audit.createdAt >= :since', { since })
      .groupBy('audit.category');

    const results = await query.getRawMany();

    const summary: Record<string, number> = {};
    results.forEach((r) => {
      summary[r.category] = parseInt(r.count, 10);
    });

    return summary;
  }

  async getDailyActivity(days = 30): Promise<Array<{ date: string; count: number }>> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .select("DATE(audit.createdAt) as date")
      .addSelect('COUNT(*)', 'count')
      .where('audit.createdAt >= :since', { since })
      .groupBy('date')
      .orderBy('date', 'ASC');

    const results = await query.getRawMany();

    return results.map((r) => ({
      date: r.date,
      count: parseInt(r.count, 10),
    }));
  }
}
