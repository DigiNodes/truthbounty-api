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
 * Durable abuse action record (PREWAVE-BE-111, #812).
 *
 * Every bounded, appealable action issued by the abuse-signals module is
 * persisted here so that:
 *
 *  1. An action survives the process that created it.
 *  2. Two replicas converge on the same enforcement decision for one subject.
 *  3. An appeal filed on replica A can lift an action visible to replica B.
 *  4. Expired actions deterministically stop enforcement without operator
 *     intervention (read path filters by `expiresAt`).
 *
 * **Lifecycle:** Actions start `ACTIVE`, become `EXPIRED` when `expiresAt`
 * passes, `LIFTED` when an approved appeal clears them, or `SUPERSEDED` when
 * a newer action replaces them (escalation or de-escalation).
 *
 * **Privacy:** `subjectKey` is an HMAC digest, never a raw address/wallet/user
 * id. Binding provenance is public chain/release metadata, not personal data.
 *
 * **Provenance:** Every action is stamped with the release binding
 * (chain/release/deployment/artifact) so actions cannot leak across
 * deployments, chains, or artifact versions.
 */
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

@Entity('abuse_actions')
@Index(['subjectKey', 'startedAt'])
@Index(['expiresAt'])
@Index(['status'])
@Check('chk_abuse_action_kind', `"kind" IN (${ACTION_KINDS_SQL})`)
@Check('chk_abuse_action_status', `"status" IN (${ACTION_STATUSES_SQL})`)
@Check(
  'chk_abuse_action_expiry',
  '"expiresAt" > "startedAt"',
)
@Check(
  'chk_abuse_action_cost_multiplier',
  '"costMultiplier" >= 1.0 AND "costMultiplier" <= 1000.0',
)
@Check(
  'chk_abuse_action_escalation',
  '"escalationLevel" >= 0 AND "escalationLevel" <= 10',
)
@Check(
  'chk_abuse_action_reason_code_version',
  '"reasonCodeVersion" > 0',
)
@Check(
  'chk_abuse_action_appealable',
  '"appealable" = true',
)
@Check(
  'chk_abuse_action_binding',
  '("bindingChainId" IS NOT NULL) = ("artifactChecksum" IS NOT NULL)',
)
export class AbuseActionRecord {
  /** Deterministic id from decision context. */
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id: string;

  /** HMAC digest of the subject. Never a raw identifier. */
  @Column({ type: 'varchar', length: 64 })
  subjectKey: string;

  @Column({ type: 'varchar', length: 32 })
  subjectKind: string;

  @Column({ type: 'varchar', length: 32 })
  kind: string;

  @Column({ type: 'varchar', length: 32 })
  status: string;

  @Column({ type: 'varchar', length: 64 })
  reasonCode: string;

  @Column({ type: 'int' })
  reasonCodeVersion: number;

  @Column({ type: 'varchar', length: 32 })
  modelVersion: string;

  @Column({ type: 'varchar', length: 32 })
  configVersion: string;

  // Release binding provenance
  @Column({ type: 'int' })
  bindingChainId: number;

  @Column({ type: 'varchar', length: 64 })
  releaseId: string;

  @Column({ type: 'varchar', length: 32 })
  deploymentBlock: string;

  @Column({ type: 'varchar', length: 64 })
  artifactChecksum: string;

  /**
   * Cost multiplier for throttling actions. Always finite and >= 1.
   * For non-throttle actions, set to 1.0.
   */
  @Column({ type: 'real', default: 1.0 })
  costMultiplier: number;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  /**
   * Mandatory expiry. Enforcement reads filter by this column so expired
   * actions are never returned without operator intervention.
   */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /**
   * Always true. An automated action that is not appealable is a defect;
   * the CHECK constraint makes it impossible to record.
   */
  @Column({ type: 'boolean', default: true })
  appealable: boolean;

  /**
   * Position on the escalation ladder (0 = NONE, 1 = OBSERVE, ..., 4 = SUSPEND).
   * Used to determine if a new action supersedes an existing one.
   */
  @Column({ type: 'int', default: 0 })
  escalationLevel: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/** CHECK expressions reused verbatim by the migration. */
export const ABUSE_ACTION_CHECKS = {
  kind: ACTION_KINDS_SQL,
  status: ACTION_STATUSES_SQL,
} as const;
