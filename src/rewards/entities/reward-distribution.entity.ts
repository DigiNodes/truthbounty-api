import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('reward_distributions')
@Unique(['txHash', 'logIndex'])
@Index(['blockNumber'])
export class RewardDistribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 42, array: true })
  recipients: string[];

  @Column({ type: 'decimal', precision: 78, scale: 0, array: true })
  amounts: string[];

  @Column({ type: 'varchar', nullable: true })
  distributionId: string;

  @Column({ type: 'varchar', length: 66 })
  @Index()
  txHash: string;

  @Column({ type: 'int' })
  blockNumber: number;

  @Column({ type: 'int' })
  logIndex: number;

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
