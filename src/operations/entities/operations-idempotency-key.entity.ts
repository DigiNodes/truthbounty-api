import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
  Check,
} from 'typeorm';
import {
  OperationalCapability,
  AuthoritySource,
  RetrySubmission,
} from '../operations.types';

/**
 * Durable idempotency key record for operational retry requests.
 *
 * Replaces the process-local Map in OperationsService. Records are shared across
 * API replicas and survive restarts. Each key represents a unique retry submission
 * attempt, storing both the request context (actor, capability, expiry) and the
 * canonical outcome for replay.
 *
 * ## Idempotency semantics
 *
 * - A duplicate key for the same item replays the cached `outcome` without
 *   re-executing the retry.
 * - A duplicate key for a different item is rejected with CONFLICT.
 * - Keys expire after a TTL (default: 24 hours) and are eligible for cleanup.
 *
 * ## Transaction boundary
 *
 * Written in the same transaction as:
 * - The queue source's retry() call (e.g., updating v2_outbox_messages)
 * - The corresponding audit record in operations_audit_logs
 *
 * This guarantees that the idempotency key, the queue state change, and the
 * audit trail are atomically committed or rolled back together.
 *
 * ## Security constraints
 *
 * - No PII, private keys, or credentials in the outcome payload.
 * - The `actorId` is a sanitized identifier (admin UUID or service account).
 * - Authority capability and expiry are captured at submission time for forensics.
 *
 * ## Expiry and cleanup
 *
 * - `expiresAt` is set to createdAt + TTL on insert.
 * - Expired keys are periodically deleted by a scheduled cleanup job.
 * - Keys are retained long enough to prevent replay attacks during retry windows.
 */
@Entity('operations_idempotency_keys')
@Index('idx_ops_idem_expires', ['expiresAt'])
@Index('idx_ops_idem_item', ['itemId'])
@Index('idx_ops_idem_actor_created', ['actorId', 'createdAt'])
@Check('chk_ops_idem_expires_after_created', '"expiresAt" > "createdAt"')
export class OperationsIdempotencyKey {
  /**
   * Caller-supplied idempotency key, typically a UUID or hash.
   * Primary key. Case-sensitive.
   */
  @PrimaryColumn({ type: 'varchar', length: 256 })
  key: string;

  /**
   * Operational queue item ID this key was used to retry.
   * Checked on duplicate key submission: must match or CONFLICT is thrown.
   */
  @Column({ type: 'varchar', length: 128 })
  itemId: string;

  /**
   * Admin or service account ID that initiated the retry.
   * Nullable for system-initiated retries with no explicit actor.
   */
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  /**
   * Capability that was validated at submission time.
   * Captured for audit and forensics; not revalidated on replay.
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
   * ISO timestamp when the authority capability expires.
   * Nullable for system authority with no time-bounded expiry.
   * Captured at submission time; not revalidated on replay.
   */
  @Column({ type: 'timestamptz', nullable: true })
  authorityExpiresAt: Date | null;

  /**
   * Canonical retry submission outcome, replayed for duplicate keys.
   * Contains: { id, accepted, auditId, replayed, skipped, failed, detail }
   */
  @Column({ type: 'jsonb' })
  outcome: RetrySubmission;

  /**
   * When this idempotency key was first recorded.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * When this key becomes eligible for cleanup.
   * Set to createdAt + TTL on insert (default: 24 hours).
   * Expired keys may be deleted by periodic maintenance.
   */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
