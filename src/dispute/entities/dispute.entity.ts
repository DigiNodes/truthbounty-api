import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';

export enum DisputeStatus {
  OPEN = 'OPEN',
  REVIEWING = 'REVIEWING',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
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
@Index(['claimId'])
@Index(['status'])
@Index(['createdAt'])
@Index(['claimId', 'status'])
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  claimId: string;

  @Column({
    type: 'varchar',
    default: DisputeStatus.OPEN,
  })
  status: DisputeStatus;

  @Column({
    type: 'varchar',
  })
  trigger: DisputeTrigger;

  @Column('decimal', { precision: 5, scale: 2 })
  originalConfidence: number;

  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  finalConfidence: number;

  @Column({
    type: 'varchar',
    nullable: true,
  })
  outcome: DisputeOutcome;

  @Column({ nullable: true })
  initiatorId: string;

  @Column('simple-json', { default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'datetime', nullable: true })
  reviewStartedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}