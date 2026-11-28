import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Evidence } from './evidence.entity';

@Entity('claims')
@Index(['finalized'])
@Index(['confidenceScore'])
@Index(['resolvedVerdict'])
@Index(['resolvedAt'])
@Index(['effectiveAt'])
@Index(['effectiveAt', 'id'])
export class Claim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 5000 })
  content: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  source: string | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @Column({
    type: 'boolean',
    nullable: true,
    select: false,
    insert: false,
    update: false,
  })
  resolvedVerdict: boolean | null;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 4,
    nullable: true,
    select: false,
    insert: false,
    update: false,
  })
  confidenceScore: number | null;

  @Column({
    default: false,
    select: false,
    insert: false,
    update: false,
  })
  finalized: boolean;

  @Column({
    type: 'datetime',
    nullable: true,
    select: false,
    insert: false,
    update: false,
  })
  resolvedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deadline: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  effectiveAt: Date | null;

  @OneToMany(() => Evidence, (evidence) => evidence.claim, { cascade: true })
  evidences: Evidence[];
}
