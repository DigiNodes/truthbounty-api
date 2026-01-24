import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

export enum DisputeStatus {
  OPEN = 'OPEN',
  REVIEWING = 'REVIEWING',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

export enum DisputeOutcome {
  CONFIRMED = 'CONFIRMED', // Original claim outcome stands
  OVERTURNED = 'OVERTURNED', // Claim outcome reversed
}

export enum DisputeTrigger {
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  MINORITY_OPPOSITION = 'MINORITY_OPPOSITION',
  MANUAL = 'MANUAL',
}

@Entity('disputes')
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  claimId: string;

  @Column({
    type: 'enum',
    enum: DisputeStatus,
    default: DisputeStatus.OPEN,
  })
  status: DisputeStatus;

  @Column({
    type: 'enum',
    enum: DisputeTrigger,
  })
  trigger: DisputeTrigger;

  @Column('decimal', { precision: 5, scale: 2 })
  originalConfidence: number;

  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  finalConfidence: number;

  @Column({
    type: 'enum',
    enum: DisputeOutcome,
    nullable: true,
  })
  outcome: DisputeOutcome;

  @Column({ nullable: true })
  initiatorId: string;

  @Column('jsonb', { default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'timestamp', nullable: true })
  reviewStartedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}