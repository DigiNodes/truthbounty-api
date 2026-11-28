import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('feature_flag_audit_events')
@Index(['flagId', 'createdAt'])
@Index(['action', 'outcome'])
@Index(['flagId', 'fromVersion', 'toVersion'])
export class FeatureFlagAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  flagId: string;

  @Column()
  key: string;

  @Column({ type: 'varchar' })
  action: 'create' | 'update' | 'rollback' | 'emergency_disable';

  @Column({ nullable: true })
  actorId: string | null;

  @Column({ type: 'int', nullable: true })
  sourceVersion: number | null;

  @Column({ type: 'int', nullable: true })
  fromVersion: number | null;

  @Column({ type: 'int', nullable: true })
  toVersion: number | null;

  @Column({ type: 'varchar', default: 'applied' })
  outcome: 'applied' | 'rejected';

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  beforeState: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  afterState: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;
}
