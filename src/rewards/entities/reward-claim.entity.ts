/* eslint-disable @typescript-eslint/no-unsafe-call */
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('reward_claims')
@Unique(['txHash', 'logIndex'])
@Index(['claimId'])
@Index(['blockNumber'])
export class RewardClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 42 })
  @Index()
  walletAddress: string;

  @Column({ type: 'decimal', precision: 78, scale: 0 }) // Support large numbers
  amount: string;

  @Column({ type: 'varchar', nullable: true })
  claimId: string;

  @Column({ type: 'varchar', length: 66 })
  @Index()
  txHash: string;

  @Column({ type: 'int' })
  blockNumber: number;

  @Column({ type: 'int' })
  logIndex: number; // Unique identifier within a transaction

  @Column({ type: 'timestamp' })
  blockTimestamp: Date;

  @Column({ type: 'varchar', nullable: true })
  eventName: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'boolean', default: false })
  isProcessed: boolean;
}
