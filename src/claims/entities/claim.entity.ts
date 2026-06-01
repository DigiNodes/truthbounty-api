import { Column, Entity, Index, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Evidence } from './evidence.entity';

@Entity('claims')
@Index(['finalized'])
@Index(['confidenceScore'])
@Index(['resolvedVerdict'])
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

  @Column({ type: 'boolean', nullable: true })
  resolvedVerdict: boolean | null;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 4,
    nullable: true,
  })
  confidenceScore: number | null;

  @Column({ default: false })
  finalized: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => Evidence, (evidence) => evidence.claim, { cascade: true })
  evidences: Evidence[];
}

