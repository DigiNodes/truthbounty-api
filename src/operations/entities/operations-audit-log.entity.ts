import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import {
  OperationalCapability,
  AuthoritySource,
} from '../operations.types';

/**
 * Durable, immutable audit record for operational retry requests.
 *
 * Replaces the bounded in-memory Map in InMemoryOperationsAuditStore. Records
 * are shared across API replicas and survive restarts. Each record captures a
 * single retry submission attempt (accepted or rejected) with all context
 * necessary for forensic reconstruction, compliance, and security review.
 *
 * ## Immutability
 *
 * Once written, records are never updated or deleted (except by retention policy).
 * No UPDATE or DELETE is permitted. This is enforced by application logic and
 * should be reinforced by database triggers or RLS policies in production.
 *
 * ## Transaction boundary
 *
 * Written in the same transaction as:
 * - The idempotency key record (operations_idempotency_keys)
 * - The queue source's retry() call (e.g., updating v2_outbox_messages)
 *
 * This guarantees the audit trail matches the actual queue state change and
 * idempotency key outcome.
 *
 * ## Privacy and sanitization
 *
 * - No PII, private keys, credentials, authorization headers, or internal topology.
 * - `actorId` is a sanitized identifier (admin UUID or service account name).
 * - `subjectId` is the operational queue item ID, already a non-sensitive UUID.
 * - `resultCode` is a public error code or "ACCEPTED", never a stack trace.
 *
 * ## Retention and compliance
 *
 * - Default retention: 90 days from `createdAt`.
 * - Retention period may be extended for compliance or legal hold.
 * - Expired records are eligible for archival or deletion per retention policy.
 *
 * ## Query patterns
 *
 * - Lookup by auditId (primary key) for retry response audit trail.
 * - Lookup by actorId + createdAt for actor activity audits.
 * - Lookup by subjectId for per-item retry history.
 * - Lookup by outcome for failure analysis (rejected requests).
 */
@Entity('operations_audit_logs')
@Index('idx_ops_audit_actor_time', ['actorId', 'createdAt'])
@Index('idx_ops_audit_subject', ['subjectId'])
@Index('idx_ops_audit_outcome_time', ['outcome', 'createdAt'])
@Index('idx_ops_audit_retention', ['retentionUntil'])
export class OperationsAuditLog {
  /**
   * Unique audit identifier (UUID).
   * Returned in the RetrySubmission response and OperationsError so callers
   * can retrieve the audit record for their request.
   */
  @PrimaryColumn({ type: 'uuid' })
  auditId: string;

  /**
   * Action being audited, e.g., "queue.retry".
   * Machine-readable, stable across releases.
   */
  @Column({ type: 'varchar', length: 128 })
  action: string;

  /**
   * Capability that authorized (or failed to authorize) this action.
   * QUEUE_READ | RETRY_READ | RETRY_SUBMIT | AUDIT_READ
   */
  @Column({ type: 'varchar', length: 128 })
  capability: OperationalCapability;

  /**
   * Authority source that granted the capability.
   * SYSTEM | PROTOCOL_OPERATOR | EMERGENCY_ADMIN
   */
  @Column({ type: 'varchar', length: 64 })
  authoritySource: AuthoritySource;

  /**
   * Admin or service account ID that initiated the request.
   * Nullable for system-initiated actions with no explicit actor.
   */
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  /**
   * Outcome of the request: "accepted" or "rejected".
   */
  @Column({ type: 'varchar', length: 16 })
  outcome: 'accepted' | 'rejected';

  /**
   * Machine-readable result code.
   * For accepted: "ACCEPTED"
   * For rejected: PublicErrorCode enum value (NOT_FOUND, CONFLICT, FORBIDDEN, etc.)
   */
  @Column({ type: 'varchar', length: 64 })
  resultCode: string;

  /**
   * Subject of the action: operational queue item ID being retried.
   * Nullable if the request failed before identifying a specific item.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  subjectId: string | null;

  /**
   * When this audit record was created.
   * Set once on insert, immutable.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * When this audit record becomes eligible for archival or deletion.
   * Set to createdAt + retention period (default: 90 days).
   * Records past this date may be deleted per retention policy.
   */
  @Column({ type: 'timestamptz' })
  retentionUntil: Date;
}
