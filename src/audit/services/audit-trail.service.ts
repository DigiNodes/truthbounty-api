import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository, Not, IsNull, DeepPartial } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import {
  AuditLog,
  AuditActionType,
  AuditEntityType,
  AuditSeverity,
  AuditCategory,
} from '../entities/audit-log.entity';
import {
  AuditChainState,
  AUDIT_CHAIN_STATE_ID,
} from '../entities/audit-chain-state.entity';
import { maskIp } from '../utils/ip-masking';
import { AuditQueueService } from './audit-queue.service';
import { AuditMetricsService } from './audit-metrics.service';
import { randomUUID } from 'crypto';
import {
  computeAuditRecordHash,
  verifyAuditRecordHash,
} from '../utils/integrity';
import { TransactionRunner } from '../../database/transaction.runner';

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
export class AuditTrailService implements OnModuleInit {
  private readonly logger = new Logger(AuditTrailService.name);
  private writeBuffer: AuditLogInput[] = [];
  private bufferTimer: NodeJS.Timeout | null = null;
  private hashSecret: string | undefined;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly auditQueueService: AuditQueueService,
    private readonly auditMetricsService: AuditMetricsService,
    private readonly transactionRunner: TransactionRunner,
    private readonly configService: ConfigService,
    @Inject(REQUEST)
    private readonly request: Request,
  ) {}

  /**
   * Fail closed at boot, not at first write: a missing HMAC secret in
   * production must stop the app from starting rather than surface as a
   * write failure the first time something gets audited.
   */
  onModuleInit(): void {
    this.getHashSecret();
  }

  /**
   * Returns the HMAC key used to compute tamper-evident audit hashes.
   *
   * Fails closed in production: an app that cannot prove its own audit
   * trail hasn't been tampered with should not accept traffic. Outside
   * production (test/development), falls back to a fixed, clearly-labeled
   * dev secret so local runs and CI don't require extra setup. This
   * fallback path is unreachable when `NODE_ENV=production`.
   */
  private getHashSecret(): string {
    if (this.hashSecret) return this.hashSecret;

    const configured = this.configService.get<string>('AUDIT_HASH_SECRET');
    if (configured) {
      this.hashSecret = configured;
      return this.hashSecret;
    }

    const nodeEnv = this.configService.get<string>('NODE_ENV');
    if (nodeEnv === 'production') {
      throw new Error(
        'AUDIT_HASH_SECRET is not configured. Refusing to start: audit log ' +
          'integrity hashes cannot be computed or verified without it.',
      );
    }

    this.logger.warn(
      'AUDIT_HASH_SECRET is not set; using an insecure fixed development ' +
        'secret. This is only acceptable outside production.',
    );
    this.hashSecret = 'insecure-development-only-audit-hash-secret';
    return this.hashSecret;
  }

  async log(input: AuditLogInput): Promise<void> {
    const record: DeepPartial<AuditLog> = {
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
    };

    try {
      await this.persistChainedRecord(record);
      this.logger.debug(
        `Audit logged: ${input.actionType} on ${input.entityType} ${input.entityId}`,
      );
    } catch (error) {
      // Deliberately not rethrown: audit logging must not take down the
      // business action it's recording. The failure is not silent though,
      // it's counted and logged as a security-relevant event so it's
      // observable and actionable, not swallowed into "as if nothing
      // happened".
      this.auditMetricsService.incrementFailedWrite();
      this.logger.error(
        `SECURITY: failed to persist audit log (${input.actionType} on ${input.entityType} ${input.entityId}): ${error.message}`,
        error.stack,
      );
    }
  }

  async logBatch(inputs: AuditLogInput[]): Promise<void> {
    const records: DeepPartial<AuditLog>[] = inputs.map((input) => ({
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
    }));

    try {
      const saved = await this.persistChainedRecords(records);
      this.logger.debug(`Batch audit logged: ${saved.length} records`);
    } catch (error) {
      this.auditMetricsService.incrementFailedWrite();
      this.logger.error(
        `SECURITY: failed to batch-persist ${records.length} audit logs: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Atomically writes one audit record and links it into the hash chain.
   *
   * The row insert, its `previousHash`/`chainSequence` assignment, its
   * HMAC `integrityHash`, and the chain-state tip update all happen in a
   * single transaction with a row lock on {@link AuditChainState}. Either
   * all of it lands, or none of it does. There is no window where a row
   * exists without a valid chained hash. This is the single write path
   * used by `log()`, `logBatch()`, and the async queue processor, so no
   * writer can bypass the chain.
   *
   * Throws on failure; callers decide whether/how to surface that
   * (`log`/`logBatch` catch and report via metrics + logs so a single
   * failed audit write cannot break the business action being audited,
   * while the queue processor lets it propagate so BullMQ retries).
   */
  async persistChainedRecord(record: DeepPartial<AuditLog>): Promise<AuditLog> {
    const [saved] = await this.persistChainedRecords([record]);
    return saved;
  }

  /** Batch form of {@link persistChainedRecord}: one lock, one chain-state update. */
  async persistChainedRecords(
    records: DeepPartial<AuditLog>[],
  ): Promise<AuditLog[]> {
    if (records.length === 0) return [];
    const secret = this.getHashSecret();

    return this.transactionRunner.run(async (manager) => {
      const chainRepo = manager.getRepository(AuditChainState);
      const auditRepo = manager.getRepository(AuditLog);

      const state = await chainRepo
        .createQueryBuilder('cs')
        .setLock('pessimistic_write')
        .where('cs.id = :id', { id: AUDIT_CHAIN_STATE_ID })
        .getOne();

      if (!state) {
        throw new Error(
          'audit_chain_state row is missing; run pending migrations before writing audit logs',
        );
      }

      let previousHash = state.lastHash;
      let sequence = state.lastSequence;
      const saved: AuditLog[] = [];

      for (const record of records) {
        sequence += 1;
        const entity = auditRepo.create({
          // `id`/`createdAt` are normally left for the DB to generate, but
          // that would mean hashing happens *after* insert, in a second
          // step: exactly the non-atomic gap this change closes. Both
          // are assigned client-side here so the full record, including
          // its own id and timestamp, is known and hashed before the one
          // and only insert.
          id: (record as any).id || randomUUID(),
          createdAt: (record as any).createdAt || new Date(),
          ...record,
          previousHash,
          chainSequence: sequence,
        });
        entity.integrityHash = computeAuditRecordHash({ ...entity }, secret);

        const savedEntity = await auditRepo.save(entity);
        previousHash = savedEntity.integrityHash;
        saved.push(savedEntity);
      }

      state.lastHash = previousHash;
      state.lastSequence = sequence;
      await chainRepo.save(state);

      return saved;
    });
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
      query.andWhere('audit.entityType = :entityType', {
        entityType: filters.entityType,
      });
    }

    if (filters.actionType) {
      query.andWhere('audit.actionType = :actionType', {
        actionType: filters.actionType,
      });
    }

    if (filters.severity) {
      query.andWhere('audit.severity = :severity', {
        severity: filters.severity,
      });
    }

    if (filters.category) {
      query.andWhere('audit.category = :category', {
        category: filters.category,
      });
    }

    if (filters.userId) {
      query.andWhere('audit.userId = :userId', { userId: filters.userId });
    }

    if (filters.source) {
      query.andWhere('audit.source = :source', { source: filters.source });
    }

    if (filters.requestId) {
      query.andWhere('audit.requestId = :requestId', {
        requestId: filters.requestId,
      });
    }

    if (filters.correlationId) {
      query.andWhere('audit.correlationId = :correlationId', {
        correlationId: filters.correlationId,
      });
    }

    if (filters.startDate) {
      query.andWhere('audit.createdAt >= :startDate', {
        startDate: new Date(filters.startDate),
      });
    }

    if (filters.endDate) {
      query.andWhere('audit.createdAt <= :endDate', {
        endDate: new Date(filters.endDate),
      });
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

  async getAuditLogsByCorrelationId(
    correlationId: string,
  ): Promise<AuditLog[]> {
    return this.auditLogRepo.find({
      where: { correlationId },
      order: { createdAt: 'ASC' },
    });
  }

  async getAuditLogsByEventId(eventId: string): Promise<AuditLog | null> {
    return this.auditLogRepo.findOne({
      where: { eventId },
      relations: ['user'],
    });
  }

  /**
   * Purges audit logs whose custom retention period has expired or whose age exceeds daysToKeep.
   * Invariant: Never deletes records under active legal hold (retentionUntil > now).
   */
  async deleteOldLogs(daysToKeep: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const now = new Date();

    const query = this.auditLogRepo
      .createQueryBuilder('audit')
      .delete()
      .where(
        '((audit.retentionUntil IS NOT NULL AND audit.retentionUntil <= :now) OR (audit.retentionUntil IS NULL AND audit.createdAt < :cutoff))',
        { now, cutoff: cutoffDate },
      );

    const result = await query.execute();

    this.logger.log(
      `Purged ${result.affected || 0} audit logs older than ${daysToKeep} days`,
    );
    return result.affected || 0;
  }

  /**
   * Privacy Control: Scrubs identifiable IP addresses and User-Agents for logs older
   * than daysToKeepPii, while retaining the audit event structure for security compliance.
   */
  async scrubAgedPii(daysToKeepPii: number): Promise<number> {
    const piiCutoff = new Date();
    piiCutoff.setDate(piiCutoff.getDate() - daysToKeepPii);
    const now = new Date();

    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({
        ipAddress: '0.0.0.0',
        userAgent: 'REDACTED_PRIVACY_POLICY',
      })
      .where(
        'createdAt < :piiCutoff AND (retentionUntil IS NULL OR retentionUntil <= :now)',
        { piiCutoff, now },
      )
      .andWhere(
        "(ipAddress != '0.0.0.0' OR userAgent != 'REDACTED_PRIVACY_POLICY')",
      )
      .execute();

    this.logger.log(
      `Scrubbed PII from ${result.affected || 0} audit logs older than ${daysToKeepPii} days`,
    );
    return result.affected || 0;
  }

  /**
   * Privacy Control: Anonymizes user-specific telemetry upon right-to-erasure request.
   * Invariant: Disassociates userId and scrubs PII without corrupting immutable on-chain wallet addresses.
   */
  async anonymizeUserTelemetry(userId: string): Promise<number> {
    if (!userId) return 0;

    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({
        userId: null,
        ipAddress: '0.0.0.0',
        userAgent: 'REDACTED_PRIVACY_REQUEST',
      })
      .where('userId = :userId', { userId })
      .execute();

    this.logger.log(
      `Anonymized telemetry and disassociated user for ${result.affected || 0} audit logs (userId: ${userId})`,
    );
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

  /**
   * Verifies a single record's own hash against the current HMAC secret.
   *
   * This proves the record's content hasn't been edited since it was
   * written, but it cannot by itself reveal a deleted record or a
   * reordered chain: a deleted row simply isn't there to check. Use
   * {@link verifyChain} when the question is "has anything in this range
   * been tampered with or removed", not just "is this one row intact".
   */
  async verifyIntegrity(id: string): Promise<{
    valid: boolean;
    id: string;
    integrityHash?: string;
    reason?: string;
  }> {
    const record = await this.auditLogRepo.findOne({ where: { id } });
    if (!record) {
      return { valid: false, id, reason: 'not_found' };
    }
    if (!record.integrityHash) {
      return { valid: false, id, reason: 'hash_missing' };
    }
    const { integrityHash, ...hashable } = record;
    const valid = verifyAuditRecordHash(
      { ...hashable, integrityHash },
      this.getHashSecret(),
    );
    return valid
      ? { valid: true, id, integrityHash: record.integrityHash }
      : { valid: false, id, reason: 'hash_mismatch' };
  }

  /**
   * Walks the hash chain in `chainSequence` order and verifies it is
   * intact: every record's own HMAC checks out, every record's
   * `previousHash` matches the prior record's `integrityHash`, and there
   * are no gaps in the sequence (which would indicate a deleted record).
   *
   * Pre-chain records (`chainSequence IS NULL`, written before this
   * migration) are outside the chain by definition and are skipped, not
   * reported as broken links.
   *
   * Streams in batches rather than loading the whole table, so this is
   * safe to run over a large audit log.
   */
  async verifyChain(
    options: {
      fromSequence?: number;
      toSequence?: number;
      batchSize?: number;
    } = {},
  ): Promise<{
    valid: boolean;
    recordsChecked: number;
    brokenAt?: { id: string; chainSequence: number; reason: string };
  }> {
    const batchSize =
      options.batchSize && options.batchSize > 0 ? options.batchSize : 500;
    let cursor = options.fromSequence ?? 0;
    let recordsChecked = 0;
    const secret = this.getHashSecret();

    // Seed the expected link from the record just before the range, if
    // any, so a partial range check can still catch a broken link right
    // at its own start (a deleted or altered record at the boundary),
    // not just breaks fully inside the range.
    let expectedPreviousHash: string | null | undefined;
    if (cursor > 0) {
      const anchor = await this.auditLogRepo
        .createQueryBuilder('audit')
        .where('audit.chainSequence = :cursor', { cursor })
        .getOne();
      expectedPreviousHash = anchor?.integrityHash ?? undefined;
    }

    for (;;) {
      const query = this.auditLogRepo
        .createQueryBuilder('audit')
        .where('audit.chainSequence IS NOT NULL')
        .andWhere('audit.chainSequence > :cursor', { cursor })
        .orderBy('audit.chainSequence', 'ASC')
        .take(batchSize);

      if (options.toSequence != null) {
        query.andWhere('audit.chainSequence <= :toSequence', {
          toSequence: options.toSequence,
        });
      }

      const batch = await query.getMany();
      if (batch.length === 0) break;

      for (const record of batch) {
        recordsChecked += 1;

        if (
          expectedPreviousHash !== undefined &&
          record.previousHash !== expectedPreviousHash
        ) {
          return {
            valid: false,
            recordsChecked,
            brokenAt: {
              id: record.id,
              chainSequence: record.chainSequence as number,
              reason: 'previous_hash_mismatch',
            },
          };
        }

        const { integrityHash, ...hashable } = record;
        if (
          !integrityHash ||
          !verifyAuditRecordHash({ ...hashable, integrityHash }, secret)
        ) {
          return {
            valid: false,
            recordsChecked,
            brokenAt: {
              id: record.id,
              chainSequence: record.chainSequence as number,
              reason: 'hash_mismatch',
            },
          };
        }

        expectedPreviousHash = record.integrityHash;
        cursor = record.chainSequence as number;
      }

      if (batch.length < batchSize) break;
    }

    return { valid: true, recordsChecked };
  }

  async placeLegalHold(
    entityType: AuditEntityType,
    entityId: string,
  ): Promise<number> {
    const retentionUntil = new Date();
    retentionUntil.setFullYear(retentionUntil.getFullYear() + 100);
    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ retentionUntil })
      .where('entityType = :entityType AND entityId = :entityId', {
        entityType,
        entityId,
      })
      .execute();
    this.logger.log(`Legal hold placed on ${entityType} ${entityId}`);
    return result.affected || 0;
  }

  async removeLegalHold(
    entityType: AuditEntityType,
    entityId: string,
    retentionDays = 365,
  ): Promise<number> {
    const retentionUntil = new Date();
    retentionUntil.setDate(retentionUntil.getDate() + retentionDays);
    const result = await this.auditLogRepo
      .createQueryBuilder()
      .update(AuditLog)
      .set({ retentionUntil })
      .where('entityType = :entityType AND entityId = :entityId', {
        entityType,
        entityId,
      })
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
    const archivedRecords = await this.auditLogRepo.count({
      where: { archived: true },
    });
    const recordsWithRetention = await this.auditLogRepo.count({
      where: { retentionUntil: Not(IsNull()) },
    });
    const pendingPurge = await this.auditLogRepo
      .createQueryBuilder('audit')
      .where('audit.createdAt < :cutoff AND audit.retentionUntil IS NULL', {
        cutoff: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      })
      .getCount();
    return {
      totalRecords,
      archivedRecords,
      recordsWithRetention,
      pendingPurge,
    };
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
