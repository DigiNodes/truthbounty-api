import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AdminAuditChainContext } from '../admin-audit.types';

@Entity('admin_audit_logs')
@Index('idx_admin_audit_correlation', ['correlationId', 'chainSequence'])
@Index('idx_admin_audit_actor_time', ['actorId', 'timestamp'])
@Index('uq_admin_audit_sequence', ['chainSequence'], { unique: true })
export class AdminAuditLog {
  @PrimaryColumn({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'bigint' })
  chainSequence: string;

  @Column({ type: 'timestamptz' })
  timestamp: Date;

  @Column({ type: 'timestamptz' })
  retentionUntil: Date;

  @Column({ type: 'uuid' })
  actorId: string;

  @Column({ type: 'varchar' })
  actorType: string;

  @Column({ type: 'varchar' })
  action: string;

  @Column({ type: 'varchar' })
  actionCategory: string;

  @Column({ type: 'varchar' })
  targetType: string;

  @Column({ type: 'uuid' })
  targetId: string;

  @Column({ type: 'varchar' })
  capability: string;

  @Column({ type: 'varchar' })
  authoritySource: string;

  @Column({ type: 'uuid' })
  authorityReference: string;

  @Column({ type: 'uuid' })
  requestReference: string;

  @Column({ type: 'uuid' })
  correlationId: string;

  @Column({ type: 'varchar' })
  outcome: string;

  @Column({ type: 'varchar' })
  severity: string;

  @Column({ type: 'uuid', nullable: true })
  resultReference: string | null;

  @Column({ type: 'jsonb', nullable: true })
  chainContext: AdminAuditChainContext | null;

  @Column({ type: 'varchar' })
  integrityHash: string;

  @Column({ type: 'varchar', nullable: true })
  previousHash: string | null;
}
