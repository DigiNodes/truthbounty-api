import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * Append-only audit row for a terminal appeal decision.
 *
 * The appeal row is the current-state projection; this table is the immutable
 * history used by operators and incident review. There is intentionally no
 * update path in the application for these records.
 */
@Entity('abuse_appeal_decision_history')
@Index(['appealId', 'decidedAt'])
export class AbuseAppealDecisionHistoryRecord {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  appealId: string;

  @Column({ type: 'varchar', length: 16 })
  status: string;

  @Column({ type: 'timestamptz' })
  decidedAt: Date;

  @Column({ type: 'varchar', length: 64 })
  decidedBy: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  decisionNote: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
