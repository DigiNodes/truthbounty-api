import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ReputationEventType {
  VERIFICATION = 'VERIFICATION',
  DISPUTE = 'DISPUTE',
  REWARD = 'REWARD',
  GOVERNANCE = 'GOVERNANCE',
  STAKING = 'STAKING',
  MILESTONE = 'MILESTONE',
}

@Entity('reputation_records')
@Index(['walletAddress'])
@Index(['score'])
@Index(['createdAt'])
@Index(['walletAddress', 'createdAt'])
export class ReputationRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  walletAddress: string;

  @Column({ type: 'int', default: 0 })
  score: number;

  @Column({ type: 'int', default: 0 })
  verificationCount: number;

  @Column({ type: 'int', default: 0 })
  disputeCount: number;

  @Column({ type: 'int', default: 0 })
  rewardTotal: number;

  @Column({ type: 'int', default: 0 })
  governanceParticipation: number;

  @Column({ type: 'int', default: 0 })
  stakingAmount: number;

  @Column({ type: 'simple-json', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('reputation_events')
@Index(['walletAddress'])
@Index(['eventType'])
@Index(['walletAddress', 'eventType'])
@Index(['walletAddress', 'createdAt'])
export class ReputationEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  walletAddress: string;

  @Column({
    type: 'varchar',
    default: ReputationEventType.VERIFICATION,
  })
  eventType: ReputationEventType;

  @Column({ type: 'int', default: 0 })
  scoreChange: number;

  @Column({ type: 'int', default: 0 })
  scoreAfter: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'simple-json', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
