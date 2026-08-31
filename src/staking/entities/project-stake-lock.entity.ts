import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A time-locked portion of a project stake. The locked amount cannot be
 * withdrawn until `unlocksAt` (UNIX seconds), regardless of the holder's
 * total balance.
 *
 * One wallet + claim pair may hold multiple locks. A lock is consumed as the
 * underlying stake is released (partially or fully) via withdrawals.
 */
@Entity('project_stake_locks')
@Index(['walletAddress'])
@Index(['claimId'])
@Index(['walletAddress', 'claimId'])
@Index(['unlocksAt'])
export class ProjectStakeLock {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  walletAddress: string;

  @Column({ type: 'varchar', length: 128 })
  claimId: string;

  /** Locked amount remaining (wei as decimal string) */
  @Column({ type: 'decimal', precision: 78, scale: 0 })
  amount: string;

  /** UNIX seconds (UTC) at which the lock expires */
  @Column({ type: 'bigint' })
  unlocksAt: string;

  /** Optional reason/label for the lock (e.g. 'stake' | 'slash-hold') */
  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
