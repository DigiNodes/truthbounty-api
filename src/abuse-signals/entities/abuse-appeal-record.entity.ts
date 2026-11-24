import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

export const ABUSE_APPEAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;

const APPEAL_STATUSES_SQL = ABUSE_APPEAL_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * Durable abuse appeal (PREWAVE-BE-086, #681).
 *
 * The record that makes an automated action genuinely appealable: a subject can
 * point at an action id, and a reviewer can point back at the decision that
 * produced it, after any restart.
 *
 * `subjectKey` is an HMAC digest, not an identifier. `reviewerId` is an internal
 * administrator id, which is why the endpoint that writes it is admin-plane
 * only and role-gated. `reason` is free text supplied by the appellant and is
 * length-bounded at the service layer; it is never rendered into any other
 * surface.
 */
@Entity('abuse_appeals')
@Index(['subjectKey', 'status'])
@Index(['actionId'])
@Check(
  'chk_abuse_appeal_status',
  `"status" IN (${APPEAL_STATUSES_SQL})`,
)
@Check(
  'chk_abuse_appeal_sla',
  '"reviewDueAt" >= "submittedAt"',
)
export class AbuseAppealRecord {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 32 })
  actionId: string;

  @Column({ type: 'varchar', length: 64 })
  subjectKey: string;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: string;

  @Column({ type: 'timestamptz' })
  submittedAt: Date;

  @Column({ type: 'timestamptz' })
  reviewDueAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  decidedBy: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote: string | null;
}