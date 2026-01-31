import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('reputation_changes')
export class ReputationChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ type: 'int' })
  oldScore: number;

  @Column({ type: 'int' })
  newScore: number;

  @Column({ type: 'int' })
  delta: number;

  @Column({ type: 'numeric', nullable: true })
  stakeAmount?: number;

  @Column({ type: 'boolean', default: false })
  isCorrect: boolean;

  @Column({ type: 'varchar', nullable: true })
  verificationId?: string;

  @CreateDateColumn()
  createdAt: Date;
}
