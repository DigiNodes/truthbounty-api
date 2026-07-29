import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type FeatureFlagType =
  | 'boolean'
  | 'percentage'
  | 'user'
  | 'role'
  | 'environment'
  | 'time';

@Entity('feature_flags')
@Index(['key', 'environment'], { unique: true })
export class FeatureFlag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  key: string;

  @Column({ type: 'varchar', default: 'boolean' })
  type: FeatureFlagType;

  @Column({ default: false })
  enabled: boolean;

  @Column({ type: 'float', default: 0 })
  rolloutPercentage: number;

  @Column({ type: 'json', nullable: true })
  rules: Record<string, unknown>;

  @Column({ default: 'development' })
  environment: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ default: 1 })
  version: number;

  @Column({ nullable: true })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
