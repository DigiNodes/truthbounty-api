import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * A source reward pool, projected from a canonical `RewardPoolSettled` event.
 *
 * This exists solely so that the sum of projected allocations can be compared
 * against a number the **contract** emitted. Without an emitted pool total
 * there is nothing to reconcile against, and "the allocations add up" would
 * only mean "the allocations agree with each other".
 *
 * `poolAmount` is verbatim from the event. It is never used to *derive* an
 * allocation, never used to top up a beneficiary, and never used to decide who
 * was paid. A mismatch between `poolAmount` and the sum of allocations is
 * reported as divergence (see `RewardsReconciliationService`); it is never
 * silently corrected, because correcting it would mean the backend inventing a
 * distribution the chain did not emit.
 */
@Entity('v2_project_reward_pool')
export class ProjectRewardPool {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  poolId: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 66 })
  claimId: string;

  @Column({ type: 'varchar', length: 42 })
  asset: string;

  /** Verbatim settled amount emitted by the contract. Decimal string. */
  @Column({ type: 'varchar', length: 100 })
  poolAmount: string;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @CreateDateColumn()
  createdAt: Date;
}
