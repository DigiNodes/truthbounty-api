import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, In } from 'typeorm';
import {
  AuditLog,
  AuditActionType,
  AuditSeverity,
  AuditCategory,
} from '../entities/audit-log.entity';
import { SecurityIncident } from '../interfaces/audit-response.interface';
import { randomUUID } from 'crypto';

export interface SecurityThresholds {
  maxFailedLogins: number;
  maxPermissionChanges: number;
  maxApiCallsPerMinute: number;
  suspiciousTimeWindowMinutes: number;
}

const DEFAULT_THRESHOLDS: SecurityThresholds = {
  maxFailedLogins: 5,
  maxPermissionChanges: 3,
  maxApiCallsPerMinute: 100,
  suspiciousTimeWindowMinutes: 15,
};

@Injectable()
export class SecurityMonitoringService {
  private readonly logger = new Logger(SecurityMonitoringService.name);
  private readonly thresholds: SecurityThresholds;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {
    this.thresholds = this.loadThresholds();
  }

  async checkFailedLogins(userId: string): Promise<SecurityIncident | null> {
    const since = new Date();
    since.setMinutes(since.getMinutes() - this.thresholds.suspiciousTimeWindowMinutes);

    const recentFailures = await this.auditLogRepo.count({
      where: {
        userId,
        actionType: AuditActionType.LOGIN_FAILED,
        createdAt: MoreThan(since),
      },
    });

    if (recentFailures >= this.thresholds.maxFailedLogins) {
      return {
        id: randomUUID(),
        type: 'BRUTE_FORCE_LOGIN',
        severity: 'HIGH',
        description: `User ${userId} had ${recentFailures} failed login attempts in ${this.thresholds.suspiciousTimeWindowMinutes} minutes`,
        timestamp: new Date().toISOString(),
        actor: userId,
        metadata: { failedAttempts: recentFailures, windowMinutes: this.thresholds.suspiciousTimeWindowMinutes },
        resolved: false,
      };
    }

    return null;
  }

  async checkPermissionEscalation(userId: string): Promise<SecurityIncident | null> {
    const since = new Date();
    since.setMinutes(since.getMinutes() - this.thresholds.suspiciousTimeWindowMinutes);

    const recentChanges = await this.auditLogRepo.count({
      where: {
        userId,
        actionType: In([
          AuditActionType.PERMISSION_CHANGED,
          AuditActionType.ROLE_ASSIGNED,
          AuditActionType.ROLE_REVOKED,
        ]),
        createdAt: MoreThan(since),
      },
    });

    if (recentChanges >= this.thresholds.maxPermissionChanges) {
      return {
        id: randomUUID(),
        type: 'PERMISSION_ESCALATION',
        severity: 'HIGH',
        description: `User ${userId} had ${recentChanges} permission/role changes in ${this.thresholds.suspiciousTimeWindowMinutes} minutes`,
        timestamp: new Date().toISOString(),
        actor: userId,
        metadata: { changes: recentChanges, windowMinutes: this.thresholds.suspiciousTimeWindowMinutes },
        resolved: false,
      };
    }

    return null;
  }

  async checkSuspiciousApiUsage(userId: string, requestCount: number): Promise<SecurityIncident | null> {
    if (requestCount > this.thresholds.maxApiCallsPerMinute) {
      return {
        id: randomUUID(),
        type: 'SUSPICIOUS_API_USAGE',
        severity: 'MEDIUM',
        description: `User ${userId} made ${requestCount} API calls (threshold: ${this.thresholds.maxApiCallsPerMinute})`,
        timestamp: new Date().toISOString(),
        actor: userId,
        metadata: { requestCount, threshold: this.thresholds.maxApiCallsPerMinute },
        resolved: false,
      };
    }

    return null;
  }

  async getRecentSecurityEvents(minutes = 60): Promise<SecurityIncident[]> {
    const since = new Date();
    since.setMinutes(since.getMinutes() - minutes);

    const criticalLogs = await this.auditLogRepo.find({
      where: [
        {
          actionType: AuditActionType.LOGIN_FAILED,
          createdAt: MoreThan(since),
        },
        {
          actionType: AuditActionType.PERMISSION_CHANGED,
          createdAt: MoreThan(since),
        },
        {
          severity: In([AuditSeverity.HIGH, AuditSeverity.CRITICAL]),
          createdAt: MoreThan(since),
        },
      ],
      order: { createdAt: 'DESC' },
      take: 100,
    });

    const grouped = this.groupSecurityEvents(criticalLogs);
    return Object.values(grouped);
  }

  async getFailedLoginReport(days = 7): Promise<{ total: number; byUser: Record<string, number>; events: AuditLog[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const events = await this.auditLogRepo.find({
      where: {
        actionType: AuditActionType.LOGIN_FAILED,
        createdAt: MoreThan(since),
      },
      order: { createdAt: 'DESC' },
    });

    const byUser: Record<string, number> = {};
    events.forEach((e) => {
      const key = e.userId || e.ipAddress || 'unknown';
      byUser[key] = (byUser[key] || 0) + 1;
    });

    return { total: events.length, byUser, events };
  }

  async getAdminActivityReport(days = 30): Promise<{ total: number; byAdmin: Record<string, number>; events: AuditLog[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const events = await this.auditLogRepo.find({
      where: {
        category: AuditCategory.ADMINISTRATIVE,
        createdAt: MoreThan(since),
      },
      order: { createdAt: 'DESC' },
    });

    const byAdmin: Record<string, number> = {};
    events.forEach((e) => {
      const key = e.userId || 'unknown';
      byAdmin[key] = (byAdmin[key] || 0) + 1;
    });

    return { total: events.length, byAdmin, events };
  }

  private groupSecurityEvents(logs: AuditLog[]): Record<string, SecurityIncident> {
    const groups: Record<string, SecurityIncident> = {};

    logs.forEach((log) => {
      const key = log.userId || log.ipAddress || 'unknown';

      if (!groups[key]) {
        groups[key] = {
          id: randomUUID(),
          type: 'SECURITY_EVENT',
          severity: log.severity,
          description: `Security events detected for ${key}`,
          timestamp: log.createdAt.toISOString(),
          actor: log.userId || 'unknown',
          ipAddress: log.ipAddress || undefined,
          metadata: { eventCount: 0, events: [] },
          resolved: false,
        };
      }

      if (!groups[key].metadata) groups[key].metadata = {};
      if (!groups[key].metadata.eventCount) groups[key].metadata.eventCount = 0;
      if (!groups[key].metadata.events) groups[key].metadata.events = [];
      groups[key].metadata.eventCount++;
      groups[key].metadata.events.push({
        actionType: log.actionType,
        description: log.description,
        timestamp: log.createdAt.toISOString(),
      });
    });

    return groups;
  }

  private loadThresholds(): SecurityThresholds {
    return {
      maxFailedLogins: parseInt(process.env.AUDIT_MAX_FAILED_LOGINS ?? String(DEFAULT_THRESHOLDS.maxFailedLogins), 10),
      maxPermissionChanges: parseInt(process.env.AUDIT_MAX_PERMISSION_CHANGES ?? String(DEFAULT_THRESHOLDS.maxPermissionChanges), 10),
      maxApiCallsPerMinute: parseInt(process.env.AUDIT_MAX_API_CALLS ?? String(DEFAULT_THRESHOLDS.maxApiCallsPerMinute), 10),
      suspiciousTimeWindowMinutes: parseInt(process.env.AUDIT_SUSPICIOUS_WINDOW_MINUTES ?? String(DEFAULT_THRESHOLDS.suspiciousTimeWindowMinutes), 10),
    };
  }
}
