import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('operational_controls')
export class OperationalControl {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'boolean', default: false })
  maintenanceActive: boolean;

  @Column({ type: 'varchar', nullable: true })
  maintenanceReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  maintenanceStartedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  maintenanceScheduledEnd: Date | null;

  @Column({ type: 'jsonb', default: [] })
  schedules: Record<string, unknown>[];

  @Column({ type: 'jsonb', default: {} })
  emergencies: Record<string, unknown>;

  @Column({ type: 'jsonb', default: {} })
  services: Record<string, boolean>;

  @Column({ type: 'jsonb', default: {} })
  pendingCanonicalActions: Record<string, unknown>;

  @Column({ type: 'varchar', nullable: true })
  @Index()
  updatedBy: string | null;

  @VersionColumn()
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
