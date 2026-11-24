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
 * Durable abuse decision record (PREWAVE-BE-086, #681).
 *
 * Abuse decisions are operational evidence, not protocol state: nothing reads
 * this table to compute a claim outcome, a reward, a dispute result or any
 * other canonical fact. It exists so an appeal filed today can still be matched
 * to the decision that caused it after a restart.
 *
 * Every enum-shaped column is mirrored by a CHECK constraint, following
 * `v2_event_quarantine`, so a database write can never introduce a code the
 * TypeScript registry does not know about.
 *
 * **Privacy:** `subjectKey` is an HMAC digest, never an address, wallet or user
 * id. The binding columns are provenance, not personal data. No request body,
 * evidence reference, credential, signature or user agent is stored.
 */
export const ABUSE_DECISION_OUTCOMES = [
  'no_signal',
  'suppressed',
  'actioned',
  'observed_only',
  'indeterminate',
] as const;

export const ABUSE_DECISION_INDETERMINATE_REASONS = [
  'unattributed',
  'release_binding_invalid',
  'enforcement_disabled',
  'store_unavailable',
] as const;

export const ABUSE_ACTION_KINDS = [
  'none',
  'observe',
  'throttle',
  'challenge',
  'suspend',
] as const;

export const ABUSE_ACTION_STATUSES = [
  'active',
  'expired',
  'lifted',
  'superseded',
] as const;

const ACTION_KINDS_SQL = ABUSE_ACTION_KINDS.map((k) => `'${k}'`).join(',');
const ACTION_STATUSES_SQL = ABUSE_ACTION_STATUSES.map((s) => `'${s}'`).join(',');
const OUTCOMES_SQL = ABUSE_DECISION_OUTCOMES.map((o) => `'${o}'`).join(',');
const INDETERMINATE_SQL = ABUSE_DECISION_INDETERMINATE_REASONS.map((r) => `'${r}'`).join(',');

@Entity('abuse_decisions')
@Index(['subjectKey', 'decidedAt'])
@Index(['decidedAt'])
@Check(
  'chk_abuse_decision_outcome',
  `"outcome" IN (${OUTCOMES_SQL})`,
)
@Check(
  'chk_abuse_decision_indeterminate_reason',
  `"indeterminateReason" IS NULL OR "indeterminateReason" IN (${INDETERMINATE_SQL})`,
)
@Check(
  'chk_abuse_decision_binding',
  '("bindingChainId" IS NULL) = ("artifactChecksum" IS NULL)',
)
@Check(
  'chk_abuse_decision_action_bound',
  `("actionId" IS NULL) = ("actionKind" IS NULL)
     AND ("actionId" IS NULL) = ("actionStatus" IS NULL)
     AND ("actionId" IS NULL) = ("actionExpiresAt" IS NULL)`,
)
@Check(
  'chk_abuse_decision_appealable',
  '"appealable" = true',
)
export class AbuseDecisionRecord {
  /** Deterministic id: identical observations produce an identical id. */
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id: string;

  /** HMAC digest of the subject. Never a raw identifier. */
  @Column({ type: 'varchar', length: 64 })
  subjectKey: string;

  @Column({ type: 'varchar', length: 32 })
  subjectKind: string;

  @Column({ type: 'varchar', length: 32 })
  outcome: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  indeterminateReason: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reasonCode: string | null;

  @Column({ type: 'int', nullable: true })
  reasonCodeVersion: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  signalKind: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  severity: string | null;

  @Column({ type: 'real', default: 0 })
  confidence: number;

  @Column({ type: 'int', default: 0 })
  sampleCount: number;

  @Column({ type: 'int', default: 0 })
  corroboratingDimensions: number;

  @Column({ type: 'varchar', length: 32 })
  modelVersion: string;

  @Column({ type: 'varchar', length: 32 })
  configVersion: string;

  // Release provenance. Nullable together: a decision issued without a valid
  // binding is indeterminate and carries no provenance at all.
  @Column({ type: 'int', nullable: true })
  bindingChainId: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  releaseId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  deploymentBlock: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactChecksum: string | null;

  // The bounded action. Absent for non-actioned outcomes.
  @Column({ type: 'varchar', length: 32, nullable: true })
  actionId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  actionKind: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  actionStatus: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  actionExpiresAt: Date | null;

  @Column({ type: 'int', default: 0 })
  escalationLevel: number;

  /**
   * Always true, and constrained so it must be: an automated action that is
   * not appealable is a defect, and the database is the cheapest place to make
   * that impossible to record.
   */
  @Column({ type: 'boolean', default: true })
  appealable: boolean;

  @Column({ type: 'timestamptz' })
  decidedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/** CHECK expressions reused verbatim by the migration. */
export const ABUSE_DECISION_CHECKS = {
  outcome: OUTCOMES_SQL,
  indeterminateReason: INDETERMINATE_SQL,
  actionKind: ACTION_KINDS_SQL,
  actionStatus: ACTION_STATUSES_SQL,
} as const;