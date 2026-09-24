import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A recorded, idempotent project-stake withdrawal.
 *
 * `txHash` is unique: re-applying the same withdrawal (e.g. from an indexer
 * replay) is a safe no-op that never double-debits the entitlements balance.
 */
@Entity('project_stake_withdrawals')
@Index(['txHash'], { unique: true })
@Index(['walletAddress'])
@Index(['claimId'])
@Index(['walletAddress', 'claimId'])
export class ProjectStakeWithdrawal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  walletAddress: string;

  @Column({ type: 'varchar', length: 128 })
  claimId: string;

  /** Withdrawn amount (wei as decimal string) */
  @Column({ type: 'decimal', precision: 78, scale: 0 })
  amount: string;

  @Column({ type: 'varchar', length: 128 })
  txHash: string;

  @Column({ type: 'int' })
  blockNumber: number;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;
}
