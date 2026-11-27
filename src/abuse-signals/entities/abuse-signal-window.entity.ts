import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Durable abuse signal window record (PREWAVE-BE-111, #812).
 *
 * Persists per-subject aggregates for the current evaluation window so that
 * multiple replicas fed the same observations converge on the same counters.
 * Windows expire naturally when their windowStart + windowMs boundary passes,
 * and are cleaned up by a periodic job or TTL policy.
 *
 * **Atomicity:** The `record()` operation uses UPDATE ... RETURNING to fold
 * observations into existing windows atomically, so concurrent requests from
 * different replicas never lose increments.
 *
 * **Bounded collections:** JSONB columns for `distinctRoutes`,
 * `distinctCredentials`, and friends are capped at the same limits the
 * in-memory store uses. Saturation is recorded rather than allowing unbounded
 * growth.
 *
 * **Privacy:** `subjectKey` is an HMAC digest, never a raw identifier.
 * `distinctCredentials` contains salted fingerprints, never real credentials.
 * `subjectsPerCredential` is a map of fingerprints to counts, not a list of
 * subject keys.
 */
export const ABUSE_SUBJECT_KINDS = ['principal', 'wallet', 'network_prefix'] as const;

const SUBJECT_KINDS_SQL = ABUSE_SUBJECT_KINDS.map((k) => `'${k}'`).join(',');

@Entity('abuse_signal_windows')
@Index(['subjectKey', 'windowStart'], { unique: true })
@Index(['windowStart'])
@Index(['expiresAt'])
@Check('chk_abuse_window_subject_kind', `"subjectKind" IN (${SUBJECT_KINDS_SQL})`)
@Check('chk_abuse_window_boundaries', '"windowMs" > 0 AND "windowStart" >= 0')
@Check('chk_abuse_window_expiry', '"expiresAt" > "windowStart"')
@Check('chk_abuse_window_counters', `
  "total" >= 0 
  AND "reads" >= 0 
  AND "writes" >= 0 
  AND "authFailures" >= 0 
  AND "authSuccesses" >= 0
  AND "webhookEndpointWrites" >= 0
  AND "webhookSecretRotations" >= 0
  AND "webhookDeliveries" >= 0
  AND "streamConnect" >= 0
  AND "streamDisconnect" >= 0
  AND "streamSubscribeOps" >= 0
  AND "streamMessages" >= 0
  AND "supportRequests" >= 0
  AND "supportDuplicateRequests" >= 0
  AND "duplicatePayloadOverflow" >= 0
`)
export class AbuseSignalWindowRecord {
  /** Deterministic: subjectKey + windowStart. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  id: string;

  /** HMAC digest of the subject. Never a raw identifier. */
  @Column({ type: 'varchar', length: 64 })
  subjectKey: string;

  @Column({ type: 'varchar', length: 32 })
  subjectKind: string;

  /** Unix timestamp (ms) of the fixed window start. */
  @Column({ type: 'bigint' })
  windowStart: string;

  /** Window duration in milliseconds. */
  @Column({ type: 'int' })
  windowMs: number;

  /**
   * When this window should be considered expired and eligible for cleanup.
   * Set to windowStart + (2 * windowMs) to allow for clock skew.
   */
  @Column({ type: 'bigint' })
  expiresAt: string;

  // Aggregate counters
  @Column({ type: 'int', default: 0 })
  total: number;

  @Column({ type: 'int', default: 0 })
  reads: number;

  @Column({ type: 'int', default: 0 })
  writes: number;

  @Column({ type: 'int', default: 0 })
  authFailures: number;

  @Column({ type: 'int', default: 0 })
  authSuccesses: number;

  @Column({ type: 'int', default: 0 })
  webhookEndpointWrites: number;

  @Column({ type: 'int', default: 0 })
  webhookSecretRotations: number;

  @Column({ type: 'int', default: 0 })
  webhookDeliveries: number;

  @Column({ type: 'int', default: 0 })
  streamConnect: number;

  @Column({ type: 'int', default: 0 })
  streamDisconnect: number;

  @Column({ type: 'int', default: 0 })
  streamSubscribeOps: number;

  @Column({ type: 'int', default: 0 })
  streamMessages: number;

  @Column({ type: 'int', default: 0 })
  supportRequests: number;

  @Column({ type: 'int', default: 0 })
  supportDuplicateRequests: number;

  // Bounded distinct collections (JSONB for efficiency)
  /** Array of distinct route groups, capped at ABUSE_WINDOW_LIMITS.distinctCap. */
  @Column({ type: 'jsonb', default: '[]' })
  distinctRoutes: string[];

  @Column({ type: 'boolean', default: false })
  routeSaturationHit: boolean;

  /** Array of credential fingerprints (salted digests), capped. */
  @Column({ type: 'jsonb', default: '[]' })
  distinctCredentials: string[];

  @Column({ type: 'boolean', default: false })
  credentialSaturationHit: boolean;

  /** Array of support contact identifiers, capped. */
  @Column({ type: 'jsonb', default: '[]' })
  supportContacts: string[];

  @Column({ type: 'boolean', default: false })
  supportContactSaturationHit: boolean;

  /**
   * Map of payload fingerprint -> repeat count.
   * Stored as JSONB object: { "fingerprint": count, ... }
   * Capped at ABUSE_WINDOW_LIMITS.payloadCap distinct keys.
   */
  @Column({ type: 'jsonb', default: '{}' })
  duplicatePayloadCounts: Record<string, number>;

  @Column({ type: 'int', default: 0 })
  duplicatePayloadOverflow: number;

  /**
   * Support-specific duplicate payload counts.
   * Stored as JSONB object: { "fingerprint": count, ... }
   */
  @Column({ type: 'jsonb', default: '{}' })
  supportDuplicateCounts: Record<string, number>;

  /**
   * Map of credential fingerprint -> distinct subject count.
   * Stored as JSONB object: { "fingerprint": subjectCount, ... }
   */
  @Column({ type: 'jsonb', default: '{}' })
  subjectsPerCredential: Record<string, number>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/** CHECK expressions reused verbatim by the migration. */
export const ABUSE_WINDOW_CHECKS = {
  subjectKind: SUBJECT_KINDS_SQL,
} as const;
