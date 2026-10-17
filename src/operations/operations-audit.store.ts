import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable } from '@nestjs/common';
import { OperationalAuditRecord } from './operations.types';

/** Injection token for the operational audit store. */
export const OPERATIONS_AUDIT_STORE = Symbol('OPERATIONS_AUDIT_STORE');

/**
 * Durable lookup for audit records produced by protected operations requests.
 *
 * Records MUST be sanitized: no secrets, protected evidence, credentials, raw
 * authorization headers or internal topology.
 */
export interface OperationsAuditStore {
  save(record: OperationalAuditRecord): Promise<void>;
  get(auditId: string): Promise<OperationalAuditRecord | null>;
}

/**
 * Default in-process audit store.
 *
 * Bounded so a long-running process cannot grow without limit. Deployments that
 * need durable lookup across restarts bind a persistent implementation to
 * {@link OPERATIONS_AUDIT_STORE}. Records are already sanitized by the caller.
 */
@Injectable()
export class InMemoryOperationsAuditStore implements OperationsAuditStore {
  private readonly max = Number(getRuntimeEnvironment().OPERATIONS_AUDIT_MAX ?? 10_000);
  private readonly records = new Map<string, OperationalAuditRecord>();

  save(record: OperationalAuditRecord): Promise<void> {
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
}
