import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, Like, In, Not, IsNull } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
  AuditLog,
  AuditActionType,
  AuditEntityType,
  AuditSeverity,
  AuditCategory,
} from '../entities/audit-log.entity';
import { maskIp } from '../utils/ip-masking';
import { AuditQueueService } from './audit-queue.service';
import { randomUUID } from 'crypto';
import { AuditPaginatedResponse } from '../interfaces/audit-response.interface';
import { generateAuditHash, verifyAuditIntegrity } from '../utils/integrity';

export interface AuditLogInput {
  actionType: AuditActionType;
  entityType: AuditEntityType;
  entityId: string;
  userId?: string;
  walletAddress?: string;
  severity?: AuditSeverity;
  category?: AuditCategory;
  source?: string;
  requestId?: string;
  description?: string;
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  metadata?: Record<string, any>;
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  retentionUntil?: Date;
}

export interface AuditQueryResult {
  logs: AuditLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AuditQueryFilters {
  entityType?: AuditEntityType;
  actionType?: AuditActionType;
  severity?: AuditSeverity;
  category?: AuditCategory;
  userId?: string;
  source?: string;
  requestId?: string;
  correlationId?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class AuditTrailService {
  private readonly logger = new Logger(AuditTrailService.name);
  private writeBuffer: AuditLogInput[] = [];
  private bufferTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly auditQueueService: AuditQueueService,
    @Inject(REQUEST)
    private readonly request: Request,
  ) {}

  async log(input: AuditLogInput): Promise<void> {
    try {
      const eventId = randomUUID();
      const auditLog = this.auditLogRepo.create({
        eventId,
        actionType: input.actionType,
        entityType: input.entityType,
        entityId: input.entityId,
        userId: input.userId,
        walletAddress: input.walletAddress,
        severity: input.severity || AuditSeverity.LOW,
        category: input.category || AuditCategory.OPERATIONS,
        source: input.source || this.getSource(),
        requestId: input.requestId || this.getRequestId(),
        description: input.description,
        beforeState: input.beforeState,
        afterState: input.afterState,
        metadata: input.metadata,
        correlationId: input.correlationId || this.getCorrelationId(),
        ipAddress: input.ipAddress || maskIp(this.getClientIp()),
        userAgent: input.userAgent || this.request?.get('user-agent'),
        retentionUntil: input.retentionUntil || null,
      });

      const saved = await this.auditLogRepo.save(auditLog);
      await this.stampIntegrityHash(saved.id);
      this.logger.debug(`Audit logged: ${input.actionType} on ${input.entityType} ${input.entityId}`);
    } catch (error) {
      this.logger.error(`Failed to log audit: ${error.message}`, error.stack);
    }
  }

  async logBatch(inputs: AuditLogInput[]): Promise<void> {
    try {
      const auditLogs = inputs.map((input) =>
        this.auditLogRepo.create({
          eventId: randomUUID(),
          actionType: input.actionType,
          entityType: input.entityType,
          entityId: input.entityId,
          userId: input.userId,
          walletAddress: input.walletAddress,
          severity: input.severity || AuditSeverity.LOW,
          category: input.category || AuditCategory.OPERATIONS,
          source: input.source || this.getSource(),
          requestId: input.requestId || this.getRequestId(),
          description: input.description,
          beforeState: input.beforeState,
          afterState: input.afterState,
          metadata: input.metadata,
          correlationId: input.correlationId || this.getCorrelationId(),
          ipAddress: input.ipAddress || maskIp(this.getClientIp()),
          userAgent: input.userAgent || this.request?.get('user-agent'),
          retentionUntil: input.retentionUntil || null,
        }),
      );

      const saved = await this.auditLogRepo.save(auditLogs);
      await Promise.all(saved.map((record) => this.stampIntegrityHash(record.id)));
      this.logger.debug(`Batch audit logged: ${auditLogs.length} records`);
    } catch (error) {
      this.logger.error(`Failed to batch log audits: ${error.message}`, error.stack);
    }
  }

  async logAsync(input: AuditLogInput): Promise<void> {
    await this.auditQueueService.enqueue(input);
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

  async query(filters: AuditQueryFilters): Promise<AuditQueryResult> {
    const page = filters.page || 1;
    const limit = filters.limit || 50;
    const offset = (page - 1) * limit;

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .orderBy('audit.createdAt', 'DESC');

    if (filters.entityType) {
      query.andWhere('audit.entityType = :entityType', { entityType: filters.entityType });
    }

    if (filters.actionType) {
      query.andWhere('audit.actionType = :actionType', { actionType: filters.actionType });
    }

    if (filters.severity) {
      query.andWhere('audit.severity = :severity', { severity: filters.severity });
    }

    if (filters.category) {
      query.andWhere('audit.category = :category', { category: filters.category });
    }

    if (filters.userId) {
      query.andWhere('audit.userId = :userId', { userId: filters.userId });
    }

    if (filters.source) {
      query.andWhere('audit.source = :source', { source: filters.source });
    }

    if (filters.requestId) {
      query.andWhere('audit.requestId = :requestId', { requestId: filters.requestId });
    }

    if (filters.correlationId) {
      query.andWhere('audit.correlationId = :correlationId', { correlationId: filters.correlationId });
    }

    if (filters.startDate) {
      query.andWhere('audit.createdAt >= :startDate', { startDate: new Date(filters.startDate) });
    }

    if (filters.endDate) {
      query.andWhere('audit.createdAt <= :endDate', { endDate: new Date(filters.endDate) });
    }

    if (filters.search) {
      query.andWhere(
        '(audit.description LIKE :search OR audit.entityId LIKE :search)',
        { search: `%${filters.search}%` },
      );
    }

    const [logs, total] = await query
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);

    return { logs, total, page, limit, totalPages };
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
      .where('audit.createdAt BETWEEN :startDate AND :endDate', { startDate, endDate })
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
    results.forEach((r) => {
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
      changes: this.computeChanges(log.beforeState || {}, log.afterState || {}),
    }));
  }

  async getAuditLogsByCorrelationId(correlationId: string): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { correlationId },
      order: { createdAt: 'ASC' },
    });
  }

  async getAuditLogsByEventId(eventId: string): Promise<AuditLog | null> {
    return this.auditLogRepo.findOne({ where: { eventId }, relations: ['user'] });
  }

  async deleteOldLogs(daysToKeep: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .delete()
      .where('audit.createdAt < :cutoff AND audit.retentionUntil IS NULL', {
        cutoff: cutoffDate,
      });

    const result = await query.execute();

    this.logger.log(`Purged ${result.affected || 0} audit logs older than ${daysToKeep} days`);
    return result.affected || 0;
  }

  async getStorageStats(): Promise<{ totalRecords: number; oldestRecord: Date | null; newestRecord: Date | null }> {
    const totalRecords = await this.auditLogRepo.count();
    const oldest = await this.auditLogRepo
      .createQueryBuilder('audit')
      .orderBy('audit.createdAt', 'ASC')
      .getOne();
    const newest = await this.auditLogRepo
      .createQueryBuilder('audit')
      .orderBy('audit.createdAt', 'DESC')
      .getOne();

    return {
      totalRecords,
      oldestRecord: oldest?.createdAt || null,
      newestRecord: newest?.createdAt || null,
    };
  }

  async stampIntegrityHash(id: string): Promise<void> {
    try {
      const record = await this.auditLogRepo.findOne({ where: { id } });
      if (!record) return;
      const { integrityHash: _existing, ...hashable } = record;
      record.integrityHash = generateAuditHash(hashable as any);
      await this.auditLogRepo.update(id, { integrityHash: record.integrityHash });
    } catch (error) {
      this.logger.error(`Failed to stamp integrity hash: ${error.message}`, error.stack);
    }
  }

  async verifyIntegrity(id: string): Promise<{ valid: boolean; id: string; integrityHash?: string; reason?: string }> {
    const record = await this.auditLogRepo.findOne({ where: { id } });
    if (!record) {
      return { valid: false, id, reason: 'not_found' };
    }
    if (!record.integrityHash) {
      return { valid: false, id, reason: 'hash_missing' };
    }
    const { integrityHash, ...hashable } = record;
    const valid = verifyAuditIntegrity({ ...hashable, integrityHash });
    return valid
      ? { valid: true, id, integrityHash: record.integrityHash }
      : { valid: false, id, reason: 'hash_mismatch' };
  }

  async placeLegalHold(entityType: AuditEntityType, entityId: string): Promise<number> {
    const retentionUntil = new Date();
    retentionUntil.setFullYear(retentionUntil.getFullYear() + 100);
    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ retentionUntil })
      .where('entityType = :entityType AND entityId = :entityId', { entityType, entityId })
      .execute();
    this.logger.log(`Legal hold placed on ${entityType} ${entityId}`);
    return result.affected || 0;
  }

  async removeLegalHold(entityType: AuditEntityType, entityId: string, retentionDays = 365): Promise<number> {
    const retentionUntil = new Date();
    retentionUntil.setDate(retentionUntil.getDate() + retentionDays);
    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ retentionUntil })
      .where('entityType = :entityType AND entityId = :entityId', { entityType, entityId })
      .execute();
    this.logger.log(`Legal hold removed on ${entityType} ${entityId}`);
    return result.affected || 0;
  }

  async getRetentionStatus(): Promise<{
    totalRecords: number;
    archivedRecords: number;
    recordsWithRetention: number;
    pendingPurge: number;
  }> {
    const totalRecords = await this.auditLogRepo.count();
    const archivedRecords = await this.auditLogRepo.count({ where: { archived: true } });
    const recordsWithRetention = await this.auditLogRepo.count({
      where: { retentionUntil: Not(IsNull()) },
    });
    const pendingPurge = await this.auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.createdAt < :cutoff AND audit.retentionUntil IS NULL', {
        cutoff: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      })
      .getCount();
    return { totalRecords, archivedRecords, recordsWithRetention, pendingPurge };
  }

  getClientIp(): string | undefined {
    if (!this.request) return undefined;
    return this.request.ip || this.request.socket?.remoteAddress;
  }

  private getSource(): string {
    try {
      if (this.request) {
        const host = this.request.get('host') || 'unknown';
        return `api:${host}`;
      }
    } catch {}
    return 'system';
  }

  private getRequestId(): string | undefined {
    if (this.request?.headers['x-request-id']) {
      return this.request.headers['x-request-id'] as string;
    }
    return undefined;
  }

  private getCorrelationId(): string {
    if (this.request?.headers['x-correlation-id']) {
      return this.request.headers['x-correlation-id'] as string;
    }
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
