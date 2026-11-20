import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FeatureFlagType } from './feature-flag.entity';

@Entity('feature_flag_versions')
@Index(['flagId', 'version'], { unique: true })
@Index(['flagId', 'createdAt'])
export class FeatureFlagVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  flagId: string;

  @Column()
  key: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'varchar' })
  type: FeatureFlagType;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ type: 'float', default: 0 })
  rolloutPercentage: number;

  @Column({ type: 'jsonb', nullable: true })
  rules: Record<string, unknown> | null;

  @Column()
  environment: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'boolean', default: false })
  isPermanent: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'varchar' })
  contentHash: string;

  @Column({ type: 'varchar', nullable: true })
  previousHash: string | null;

  @Column({ type: 'int', nullable: true })
  sourceVersion: number | null;

  @Column({ type: 'varchar', default: 'valid' })
  validationStatus: 'valid' | 'invalid' | 'revoked';

  @Column({ nullable: true })
  actorId: string | null;

  @Column({ type: 'text', nullable: true })
  changeReason: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
