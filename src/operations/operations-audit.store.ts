import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, LessThan } from 'typeorm';
import { OperationalAuditRecord } from './operations.types';
import { OperationsAuditLog } from './entities/operations-audit-log.entity';

/** Injection token for the operational audit store. */
export const OPERATIONS_AUDIT_STORE = Symbol('OPERATIONS_AUDIT_STORE');

/**
 * Input for saving an audit record.
 */
export interface AuditRecordInput extends OperationalAuditRecord {
  retentionDays?: number; // Default: 90 days
}

/**
 * Durable lookup for audit records produced by protected operations requests.
 *
 * Records MUST be sanitized: no secrets, protected evidence, credentials, raw
 * authorization headers or internal topology.
 */
export interface OperationsAuditStore {
  /**
   * Save a new audit record.
   * MUST be called within a transaction (using manager parameter).
   * Records are immutable once written.
   */
  save(record: OperationalAuditRecord, manager: EntityManager): Promise<void>;

  /**
   * Get an audit record by its unique auditId.
   * Returns null if not found.
   */
  get(auditId: string): Promise<OperationalAuditRecord | null>;

  /**
   * Delete audit records past their retention period.
   * Returns the count of deleted records.
   * Used by scheduled cleanup jobs.
   */
  cleanupExpired(): Promise<number>;
}

/**
 * Default in-process audit store.
 *
 * Bounded so a long-running process cannot grow without limit. Deployments that
 * need durable lookup across restarts bind a persistent implementation to
 * {@link OPERATIONS_AUDIT_STORE}. Records are already sanitized by the caller.
 *
 * @deprecated Use DurableOperationsAuditStore for production deployments.
 */
@Injectable()
export class InMemoryOperationsAuditStore implements OperationsAuditStore {
  private readonly max = Number(
    getRuntimeEnvironment().OPERATIONS_AUDIT_MAX ?? 10_000,
  );
  private readonly records = new Map<string, OperationalAuditRecord>();

  save(
    record: OperationalAuditRecord,
    _manager?: EntityManager,
  ): Promise<void> {
    this.records.set(record.auditId, record);
    if (this.records.size > this.max) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
    return Promise.resolve();
  }

  get(auditId: string): Promise<OperationalAuditRecord | null> {
    return Promise.resolve(this.records.get(auditId) ?? null);
  }

  cleanupExpired(): Promise<number> {
    // In-memory store does not support expiry-based cleanup; eviction is LRU-style.
    return Promise.resolve(0);
  }
}

/**
 * Durable, persistent audit store using TypeORM.
 *
 * Replaces the bounded in-memory Map in InMemoryOperationsAuditStore. Records
 * are shared across API replicas, survive restarts, and are immutable once
 * written. Retention-based cleanup ensures the table doesn't grow without bound.
 *
 * ## Immutability
 *
 * Once a record is written, it is never updated or deleted (except by retention
 * policy). This is enforced by application logic: no UPDATE or DELETE is
 * permitted except via `cleanupExpired()`. Production deployments SHOULD enforce
 * this with database triggers or row-level security policies.
 *
 * ## Transaction boundary
 *
 * The `save()` method MUST be called with an EntityManager from an active
 * transaction. This ensures the audit record, idempotency key, and queue source
 * update are atomically committed together.
 *
 * ## Privacy and sanitization
 *
 * The caller is responsible for sanitization. This store persists records
 * as-is. Ensure no PII, secrets, credentials, authorization headers, or internal
 * topology are included in the input.
 *
 * ## Retention and compliance
 *
 * Records are retained for a configurable period (default: 90 days). Expired
 * records (retentionUntil < now) are periodically deleted by calling
 * `cleanupExpired()` from a scheduled job or maintenance task.
 */
@Injectable()
export class DurableOperationsAuditStore implements OperationsAuditStore {
  private readonly logger = new Logger(DurableOperationsAuditStore.name);
  private readonly defaultRetentionDays = 90;

  constructor(
    @InjectRepository(OperationsAuditLog)
    private readonly repo: Repository<OperationsAuditLog>,
  ) {}

  async save(
    record: OperationalAuditRecord,
    manager: EntityManager,
  ): Promise<void> {
    const input = record as AuditRecordInput;
    const retentionDays = input.retentionDays ?? this.defaultRetentionDays;
    const createdAt = new Date(record.createdAt);
    const retentionUntil = new Date(
      createdAt.getTime() + retentionDays * 86400 * 1000,
    );

    const entity = manager.getRepository(OperationsAuditLog).create({
      auditId: record.auditId,
      action: record.action,
      capability: record.capability,
      authoritySource: record.authoritySource,
      actorId: record.actorId,
      outcome: record.outcome,
      resultCode: record.resultCode,
      subjectId: record.subjectId,
      createdAt,
      retentionUntil,
    });

    await manager.getRepository(OperationsAuditLog).save(entity);

    this.logger.log(
      `Audit record saved: ${record.auditId} (action=${record.action}, outcome=${record.outcome}, retentionUntil=${retentionUntil.toISOString()})`,
    );
  }

  async get(auditId: string): Promise<OperationalAuditRecord | null> {
    const entity = await this.repo.findOne({ where: { auditId } });
    if (!entity) return null;

    return {
      auditId: entity.auditId,
      action: entity.action,
      capability: entity.capability,
      authoritySource: entity.authoritySource,
      actorId: entity.actorId,
      outcome: entity.outcome,
      resultCode: entity.resultCode,
      subjectId: entity.subjectId,
      createdAt: entity.createdAt.toISOString(),
    };
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(OperationsAuditLog)
      .where('retentionUntil < :now', { now })
      .execute();

    const deleted = result.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(`Cleaned up ${deleted} expired audit records.`);
    }
    return deleted;
  }
}
