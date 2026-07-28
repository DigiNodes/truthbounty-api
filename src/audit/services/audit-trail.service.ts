import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
  AuditLog,
  AuditActionType,
  AuditEntityType,
  AuditEventType,
  AuditSeverity,
} from '../entities/audit-log.entity';
import { maskIp } from '../utils/ip-masking';
import { generateAuditHash, verifyAuditIntegrity } from '../utils/integrity';

export interface AuditLogInput {
  actionType: AuditActionType;
  entityType: AuditEntityType;
  entityId: string;
  userId?: string;
  walletAddress?: string;
  actorRole?: string;
  eventType?: AuditEventType;
  resourceType?: string;
  severity?: AuditSeverity;
  description?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  metadata?: Record<string, any>;
  correlationId?: string;
  requestId?: string;
}

@Injectable()
export class AuditTrailService {
  private readonly logger = new Logger(AuditTrailService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    @Inject(REQUEST)
    private readonly request: Request,
  ) {}

  async log(input: AuditLogInput): Promise<void> {
    try {
      const correlationId = input.correlationId || this.getCorrelationId();
      const requestId = input.requestId || this.getRequestId();
      const ipAddress = maskIp(this.getClientIp());
      const userAgent = this.request?.get('user-agent');

      const auditLog = this.auditLogRepo.create({
        actionType: input.actionType,
        entityType: input.entityType,
        entityId: input.entityId,
        userId: input.userId,
        walletAddress: input.walletAddress,
        actorRole: input.actorRole,
        eventType: input.eventType,
        resourceType: input.resourceType,
        severity: input.severity || AuditSeverity.INFO,
        description: input.description,
        beforeState: input.beforeState,
        afterState: input.afterState,
        metadata: input.metadata,
        correlationId,
        requestId,
        ipAddress,
        userAgent,
      });

      const saved = await this.auditLogRepo.save(auditLog);

      const hash = generateAuditHash({
        id: saved.id,
        actionType: saved.actionType,
        entityType: saved.entityType,
        entityId: saved.entityId,
        userId: saved.userId,
        walletAddress: saved.walletAddress,
        description: saved.description,
        beforeState: saved.beforeState,
        afterState: saved.afterState,
        metadata: saved.metadata,
        ipAddress: saved.ipAddress,
        userAgent: saved.userAgent,
        correlationId: saved.correlationId,
        createdAt: saved.createdAt,
      });

      await this.auditLogRepo.update(saved.id, { integrityHash: hash });

      this.logger.debug(
        `Audit logged: ${input.actionType} on ${input.entityType} ${input.entityId} (hash: ${hash.slice(0, 12)}...)`,
      );
    } catch (error) {
      this.logger.error(`Failed to log audit: ${error.message}`, error.stack);
    }
  }

  async verifyIntegrity(id: string): Promise<{ valid: boolean; record: AuditLog | null }> {
    const record = await this.auditLogRepo.findOne({ where: { id } });
    if (!record) {
      return { valid: false, record: null };
    }

    const valid = verifyAuditIntegrity(record);
    return { valid, record };
  }

  async getEntityAuditLogs(
    entityType: AuditEntityType,
    entityId: string,
  ): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { entityType, entityId },
      order: { createdAt: 'DESC' },
      relations: ['user'],
    });
  }

  async getUserAuditLogs(
    userId: string,
    limit = 100,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const [logs, total] = await this.auditLogRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
      relations: ['user'],
    });

    return { logs, total };
  }

  async getActionAuditLogs(
    actionType: AuditActionType,
    limit = 100,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const [logs, total] = await this.auditLogRepo.findAndCount({
      where: { actionType },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
      relations: ['user'],
    });

    return { logs, total };
  }

  async getAuditLogs(
    entityType?: AuditEntityType,
    actionType?: AuditActionType,
    userId?: string,
    limit = 100,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .orderBy('audit.createdAt', 'DESC');

    if (entityType) {
      query.andWhere('audit.entityType = :entityType', { entityType });
    }

    if (actionType) {
      query.andWhere('audit.actionType = :actionType', { actionType });
    }

    if (userId) {
      query.andWhere('audit.userId = :userId', { userId });
    }

    const [logs, total] = await query
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return { logs, total };
  }

  async getAuditLogsByDateRange(
    startDate: Date,
    endDate: Date,
    limit = 100,
    offset = 0,
  ): Promise<{ logs: AuditLog[]; total: number }> {
    const [logs, total] = await this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .where('audit.createdAt BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      })
      .orderBy('audit.createdAt', 'DESC')
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return { logs, total };
  }

  async getAuditSummary(
    entityType?: AuditEntityType,
    days = 7,
  ): Promise<Record<string, number>> {
    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .select('audit.actionType', 'actionType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.actionType');

    if (entityType) {
      query.where('audit.entityType = :entityType', { entityType });
    }

    const since = new Date();
    since.setDate(since.getDate() - days);
    query.andWhere('audit.createdAt >= :since', { since });

    const results = await query.getRawMany();

    const summary: Record<string, number> = {};
    results.forEach((r: any) => {
      summary[r.actionType] = parseInt(r.count, 10);
    });

    return summary;
  }

  async getChangeHistory(
    entityType: AuditEntityType,
    entityId: string,
  ): Promise<
    Array<{
      timestamp: Date;
      action: AuditActionType;
      userId: string;
      changes: Record<string, { before: any; after: any }>;
    }>
  > {
    const logs = await this.getEntityAuditLogs(entityType, entityId);

    return logs.map((log) => ({
      timestamp: log.createdAt,
      action: log.actionType,
      userId: log.userId,
      changes: this.computeChanges(log.beforeState, log.afterState),
    }));
  }

  async deleteOldLogs(daysToKeep: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .delete()
      .where('audit.createdAt < :cutoff', { cutoff: cutoffDate })
      .andWhere('(audit.retentionUntil IS NULL OR audit.retentionUntil < :now)', { now: new Date() });

    const result = await query.execute();

    this.logger.log(
      `Purged ${result.affected || 0} audit logs older than ${daysToKeep} days`,
    );
    return result.affected || 0;
  }

  async getRetentionStatus(): Promise<{
    totalRecords: number;
    archivedRecords: number;
    legalHoldRecords: number;
    pendingCleanup: number;
  }> {
    const totalRecords = await this.auditLogRepo.count();
    const archivedRecords = await this.auditLogRepo.count({ where: { archived: true } });
    const legalHoldRecords = await this.auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.retentionUntil IS NOT NULL')
      .getCount();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 365);
    const pendingCleanup = await this.auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.createdAt < :cutoff', { cutoff: cutoffDate })
      .andWhere('(audit.retentionUntil IS NULL OR audit.retentionUntil < :now)', { now: new Date() })
      .getCount();

    return {
      totalRecords,
      archivedRecords,
      legalHoldRecords,
      pendingCleanup,
    };
  }

  async placeLegalHold(entityId: string, reason: string, initiatedBy: string): Promise<number> {
    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ retentionUntil: () => "'9999-12-31 23:59:59'" })
      .where('entityId = :entityId', { entityId })
      .execute();

    this.logger.log(`Legal hold placed on ${entityId}: ${reason} (by ${initiatedBy})`);
    return result.affected || 0;
  }

  async removeLegalHold(entityId: string): Promise<number> {
    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ retentionUntil: null })
      .where('entityId = :entityId', { entityId })
      .andWhere('retentionUntil IS NOT NULL')
      .execute();

    this.logger.log(`Legal hold removed from ${entityId}`);
    return result.affected || 0;
  }

  async getAuditLogsByCorrelationId(correlationId: string): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { correlationId },
      order: { createdAt: 'ASC' },
    });
  }

  private getClientIp(): string | undefined {
    if (!this.request) return undefined;
    return this.request.ip || this.request.socket?.remoteAddress;
  }

  private getCorrelationId(): string {
    if (this.request?.headers['x-correlation-id']) {
      return this.request.headers['x-correlation-id'] as string;
    }
    return this.generateId();
  }

  private getRequestId(): string {
    if (this.request?.headers['x-request-id']) {
      return this.request.headers['x-request-id'] as string;
    }
    return this.generateId();
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private computeChanges(
    beforeState: Record<string, any>,
    afterState: Record<string, any>,
  ): Record<string, { before: any; after: any }> {
    const changes: Record<string, { before: any; after: any }> = {};

    if (!beforeState || !afterState) return changes;

    const allKeys = new Set([
      ...Object.keys(beforeState || {}),
      ...Object.keys(afterState || {}),
    ]);

    allKeys.forEach((key) => {
      if (beforeState[key] !== afterState[key]) {
        changes[key] = {
          before: beforeState[key],
          after: afterState[key],
        };
      }
    });

    return changes;
  }
}
