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
@Index(['walletAddress'])
@Index(['txHash'])
@Index(['walletAddress', 'blockTimestamp'])
@Index(['amount'])
export class RewardClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 42 })
  walletAddress: string;

  @Column({ type: 'decimal', precision: 78, scale: 0 }) // Support large numbers
  amount: string;

  @Column({ type: 'varchar', nullable: true })
  claimId: string;

  @Column({ type: 'varchar', length: 66 })
  txHash: string;

  @Column({ type: 'int' })
  blockNumber: number;

  @Column({ type: 'int' })
  logIndex: number; // Unique identifier within a transaction

  @Column({ type: 'datetime' })
  blockTimestamp: Date;

  @Column({ type: 'varchar', nullable: true })
  eventName: string;

  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'boolean', default: false })
  isProcessed: boolean;
}
