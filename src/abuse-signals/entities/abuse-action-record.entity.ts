import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Durable bounded enforcement action referenced by an abuse decision. */
@Entity('abuse_actions')
@Index(['subjectKey', 'status', 'expiresAt'])
@Check(
  'chk_abuse_action_status',
  "\"status\" IN ('active', 'expired', 'lifted', 'superseded')",
)
@Check('chk_abuse_action_expiry', '"expiresAt" > "startedAt"')
@Check('chk_abuse_action_binding', '"bindingChainId" > 0')
export class AbuseActionRecord {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  subjectKey: string;

  @Column({ type: 'varchar', length: 32 })
  subjectKind: string;

  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ type: 'varchar', length: 16 })
  status: string;

  @Column({ type: 'varchar', length: 64 })
  reasonCode: string;

  @Column({ type: 'int' })
  reasonCodeVersion: number;

  @Column({ type: 'varchar', length: 32 })
  modelVersion: string;

  @Column({ type: 'varchar', length: 32 })
  configVersion: string;

  @Column({ type: 'int' })
  bindingChainId: number;

  @Column({ type: 'varchar', length: 64 })
  releaseId: string;

  @Column({ type: 'varchar', length: 32 })
  deploymentBlock: string;

  @Column({ type: 'varchar', length: 64 })
  artifactChecksum: string;

  @Column({ type: 'real' })
  costMultiplier: number;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'boolean', default: true })
  appealable: boolean;

  @Column({ type: 'int' })
  escalationLevel: number;
}
