import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('operational_control_events')
export class OperationalControlEvent {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  @Index()
  controlId: string;

  @Column({ type: 'varchar', length: 64 })
  operation: string;

  @Column({ type: 'varchar', length: 64 })
  actorId: string;

  @Column({ type: 'varchar', length: 255 })
  reason: string;

  @Column({ type: 'jsonb' })
  beforeState: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  afterState: Record<string, unknown>;

  @Column({ type: 'varchar', length: 255 })
  auditReference: string;

  @Column({ type: 'int' })
  controlVersion: number;

  @CreateDateColumn()
  createdAt: Date;
}
