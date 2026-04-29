import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
  AuditLog,
  AuditActionType,
  AuditEntityType,
} from '../entities/audit-log.entity';

export interface AuditLogInput {
  actionType: AuditActionType;
  entityType: AuditEntityType;
  entityId: string;
  userId?: string;
  walletAddress?: string;
  description?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  metadata?: Record<string, any>;
  correlationId?: string;
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

  /**
   * Log an action to the audit trail
   */
  async log(input: AuditLogInput): Promise<void> {
    try {
      const auditLog = this.auditLogRepo.create({
        actionType: input.actionType,
        entityType: input.entityType,
        entityId: input.entityId,
        userId: input.userId,
        walletAddress: input.walletAddress,
        description: input.description,
        beforeState: input.beforeState,
        afterState: input.afterState,
        metadata: input.metadata,
        correlationId: input.correlationId || this.getCorrelationId(),
        ipAddress: this.getClientIp(),
        userAgent: this.request?.get('user-agent'),
      });

      await this.auditLogRepo.save(auditLog);
      this.logger.debug(
        `Audit logged: ${input.actionType} on ${input.entityType} ${input.entityId}`,
      );
    } catch (error) {
      this.logger.error(`Failed to log audit: ${error.message}`, error.stack);
      // Don't throw - audit logging should not break the application
    }
  }

  /**
   * Get audit logs for a specific entity
   */
  async getEntityAuditLogs(
    entityType: AuditEntityType,
    entityId: string,
  ): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: {
        entityType,
        entityId,
      },
      order: { createdAt: 'DESC' },
      relations: ['user'],
    });
  }

  /**
   * Get audit logs for a specific user
   */
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

  /**
   * Get audit logs for a specific action type
   */
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

  /**
   * Get all audit logs for a specific entity type with filters
   */
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

  /**
   * Get audit logs within a date range
   */
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

  /**
   * Get a summary of audit logs grouped by action type
   */
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
    results.forEach((r) => {
      summary[r.actionType] = parseInt(r.count, 10);
    });

    return summary;
  }

  /**
   * Get change history for an entity
   */
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

  /**
   * Delete old audit logs (retention policy)
   */
  async deleteOldLogs(daysToKeep: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    // Use raw query due to TypeORM SQLite limitations with date comparisons
    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .delete()
      .where('audit.createdAt < :cutoff', { cutoff: cutoffDate });

    const result = await query.execute();

    this.logger.log(
      `Purged ${result.affected || 0} audit logs older than ${daysToKeep} days`,
    );
    return result.affected || 0;
  }

  private getClientIp(): string | undefined {
    if (!this.request) return undefined;

    // Use req.ip which respects trust proxy configuration
    // Falls back to socket remoteAddress for direct connections
    return this.request.ip || this.request.socket?.remoteAddress;
  }

  private getCorrelationId(): string {
    if (this.request?.headers['x-correlation-id']) {
      return this.request.headers['x-correlation-id'] as string;
    }
    return this.generateCorrelationId();
  }

  private generateCorrelationId(): string {
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

  public async getAuditLogsByCorrelationId(
    correlationId: string
  ): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { correlationId },
      order: { createdAt: 'ASC' },
    });
  }
}
