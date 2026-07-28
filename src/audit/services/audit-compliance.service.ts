import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, AuditActionType, AuditEventType, AuditSeverity } from '../entities/audit-log.entity';
import { ReportType, ReportFormat, GenerateReportDto, ReportResponse } from '../dto/compliance-report.dto';

@Injectable()
export class AuditComplianceService {
  private readonly logger = new Logger(AuditComplianceService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  async generateReport(dto: GenerateReportDto, generatedBy: string): Promise<ReportResponse> {
    const endDate = dto.endDate ? new Date(dto.endDate) : new Date();
    let startDate: Date;

    if (dto.startDate) {
      startDate = new Date(dto.startDate);
    } else if (dto.days) {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - dto.days);
    } else {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
    }

    let data: any;
    let totalEvents = 0;

    switch (dto.reportType) {
      case ReportType.ADMIN_ACTIVITY:
        data = await this.generateAdminActivityReport(startDate, endDate);
        break;
      case ReportType.MODERATION_ACTIONS:
        data = await this.generateModerationReport(startDate, endDate);
        break;
      case ReportType.GOVERNANCE_ACTIONS:
        data = await this.generateGovernanceReport(startDate, endDate);
        break;
      case ReportType.AUTHENTICATION_HISTORY:
        data = await this.generateAuthenticationReport(startDate, endDate);
        break;
      case ReportType.FAILED_ACCESS_ATTEMPTS:
        data = await this.generateFailedAccessReport(startDate, endDate);
        break;
      case ReportType.SECURITY_EVENTS:
        data = await this.generateSecurityReport(startDate, endDate);
        break;
      case ReportType.PROTOCOL_OPERATIONS:
        data = await this.generateProtocolOperationsReport(startDate, endDate);
        break;
      case ReportType.USER_ACTIVITY:
        data = await this.generateUserActivityReport(startDate, endDate);
        break;
    }

    if (data && data.events) {
      totalEvents = data.events.length;
    }

    const response: ReportResponse = {
      reportType: dto.reportType,
      generatedAt: new Date().toISOString(),
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      generatedBy,
      totalEvents,
      data,
    };

    if (dto.format === ReportFormat.CSV) {
      response.exportUrl = `data:text/csv;base64,${Buffer.from(this.convertToCsv(data)).toString('base64')}`;
    }

    return response;
  }

  private async generateAdminActivityReport(startDate: Date, endDate: Date) {
    const adminActions = [
      AuditActionType.ADMIN_ACTION,
      AuditActionType.USER_BANNED,
      AuditActionType.USER_UNBANNED,
      AuditActionType.USER_ROLE_CHANGED,
      AuditActionType.SYSTEM_CONFIG_CHANGED,
      AuditActionType.FEATURE_FLAG_CHANGED,
    ];

    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.actionType IN (:...adminActions)', { adminActions })
      .andWhere('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const byAction = this.groupBy(events, 'actionType');
    const byAdmin = this.groupBy(events, 'userId');

    return {
      events,
      summary: {
        totalAdminActions: events.length,
        uniqueAdmins: new Set(events.map((e) => e.userId).filter(Boolean)).size,
        actionsByType: Object.fromEntries(
          Object.entries(byAction).map(([key, val]) => [key, (val as any[]).length]),
        ),
        mostActiveAdmins: Object.fromEntries(
          Object.entries(byAdmin)
            .map(([key, val]) => [key, (val as any[]).length])
            .sort(([, a], [, b]) => b - a)
            .slice(0, 10),
        ),
      },
    };
  }

  private async generateModerationReport(startDate: Date, endDate: Date) {
    const modActions = [
      AuditActionType.MODERATOR_ACTION,
      AuditActionType.EVIDENCE_HIDDEN,
      AuditActionType.EVIDENCE_RESTORED,
      AuditActionType.FLAG_REVIEWED,
      AuditActionType.EVIDENCE_FLAGGED,
    ];

    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.actionType IN (:...modActions)', { modActions })
      .andWhere('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const byAction = this.groupBy(events, 'actionType');

    return {
      events,
      summary: {
        totalModActions: events.length,
        uniqueModerators: new Set(events.map((e) => e.userId).filter(Boolean)).size,
        actionsByType: Object.fromEntries(
          Object.entries(byAction).map(([key, val]) => [key, (val as any[]).length]),
        ),
      },
    };
  }

  private async generateGovernanceReport(startDate: Date, endDate: Date) {
    const govActions = [
      AuditActionType.PROPOSAL_CREATED,
      AuditActionType.PROPOSAL_UPDATED,
      AuditActionType.VOTE_CAST,
      AuditActionType.VOTE_CHANGED,
      AuditActionType.PROPOSAL_EXECUTED,
      AuditActionType.PROPOSAL_CANCELLED,
    ];

    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.actionType IN (:...govActions)', { govActions })
      .andWhere('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const byAction = this.groupBy(events, 'actionType');

    return {
      events,
      summary: {
        totalGovernanceActions: events.length,
        uniqueVoters: new Set(events.map((e) => e.userId).filter(Boolean)).size,
        actionsByType: Object.fromEntries(
          Object.entries(byAction).map(([key, val]) => [key, (val as any[]).length]),
        ),
      },
    };
  }

  private async generateAuthenticationReport(startDate: Date, endDate: Date) {
    const authActions = [
      AuditActionType.LOGIN_SUCCESS,
      AuditActionType.LOGIN_FAILED,
      AuditActionType.LOGOUT,
      AuditActionType.CHALLENGE_REQUESTED,
      AuditActionType.TOKEN_REFRESHED,
      AuditActionType.TOKEN_REVOKED,
    ];

    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.actionType IN (:...authActions)', { authActions })
      .andWhere('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const successful = events.filter((e) => e.actionType === AuditActionType.LOGIN_SUCCESS).length;
    const failed = events.filter((e) => e.actionType === AuditActionType.LOGIN_FAILED).length;

    return {
      events,
      summary: {
        totalAuthEvents: events.length,
        successfulLogins: successful,
        failedLogins: failed,
        successRate: events.length > 0 ? Math.round((successful / events.length) * 100) : 0,
        uniqueUsers: new Set(events.map((e) => e.userId).filter(Boolean)).size,
      },
    };
  }

  private async generateFailedAccessReport(startDate: Date, endDate: Date) {
    const failedActions = [
      AuditActionType.LOGIN_FAILED,
      AuditActionType.AUTHORIZATION_FAILED,
      AuditActionType.PERMISSION_DENIED,
    ];

    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.actionType IN (:...failedActions)', { failedActions })
      .andWhere('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const byIp = this.groupBy(events, 'ipAddress');
    const topIPs = Object.entries(byIp)
      .map(([ip, evts]) => ({ ip, count: (evts as any[]).length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return {
      events,
      summary: {
        totalFailedAttempts: events.length,
        uniqueIPs: new Set(events.map((e) => e.ipAddress).filter(Boolean)).size,
        uniqueUsers: new Set(events.map((e) => e.userId).filter(Boolean)).size,
        topSourceIPs: topIPs,
      },
    };
  }

  private async generateSecurityReport(startDate: Date, endDate: Date) {
    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.eventType = :eventType', { eventType: AuditEventType.SECURITY })
      .andWhere('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const criticalCount = events.filter((e) => e.severity === AuditSeverity.CRITICAL).length;
    const errorCount = events.filter((e) => e.severity === AuditSeverity.ERROR).length;

    return {
      events,
      summary: {
        totalSecurityEvents: events.length,
        criticalEvents: criticalCount,
        errorEvents: errorCount,
        warningEvents: events.filter((e) => e.severity === AuditSeverity.WARNING).length,
        bySeverity: {
          CRITICAL: criticalCount,
          ERROR: errorCount,
          WARNING: events.filter((e) => e.severity === AuditSeverity.WARNING).length,
          INFO: events.filter((e) => e.severity === AuditSeverity.INFO).length,
        },
      },
    };
  }

  private async generateProtocolOperationsReport(startDate: Date, endDate: Date) {
    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const byEventType = this.groupBy(events, 'eventType');

    return {
      events,
      summary: {
        totalOperations: events.length,
        operationsByType: Object.fromEntries(
          Object.entries(byEventType).map(([key, val]) => [key, (val as any[]).length]),
        ),
      },
    };
  }

  private async generateUserActivityReport(startDate: Date, endDate: Date) {
    const events = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere('audit.userId IS NOT NULL')
      .orderBy('audit.createdAt', 'DESC')
      .getMany();

    const byUser = this.groupBy(events, 'userId');
    const topUsers = Object.entries(byUser)
      .map(([userId, userEvents]) => ({
        userId,
        count: (userEvents as any[]).length,
        lastAction: (userEvents as any[]).sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0],
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    return {
      events,
      summary: {
        totalUserActions: events.length,
        uniqueUsers: new Set(events.map((e) => e.userId).filter(Boolean)).size,
        mostActiveUsers: topUsers,
      },
    };
  }

  private groupBy(array: any[], key: string): Record<string, any[]> {
    return array.reduce((result, item) => {
      const groupKey = item[key] || 'UNKNOWN';
      if (!result[groupKey]) {
        result[groupKey] = [];
      }
      result[groupKey].push(item);
      return result;
    }, {} as Record<string, any[]>);
  }

  private convertToCsv(data: any): string {
    if (!data || !data.events || !Array.isArray(data.events)) {
      return 'No data';
    }

    const headers = ['id', 'actionType', 'entityType', 'entityId', 'userId', 'walletAddress', 'description', 'ipAddress', 'createdAt'];
    const rows = data.events.map((event: any) =>
      headers.map((h) => {
        const val = event[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val).replace(/"/g, '""');
      }).join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }
}
