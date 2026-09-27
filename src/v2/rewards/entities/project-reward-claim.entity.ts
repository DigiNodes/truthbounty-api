import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * One emitted `RewardClaimed` event — a *withdrawal* from an allocation.
 *
 * ## Why this table exists
 *
 * An allocation's `claimedAmount` is a running total, and a running total is
 * the one thing in this projection that is **not** naturally idempotent: if the
 * same claim event were applied twice, the total would double, and the read
 * model would assert a withdrawal the chain only made once. Every other write
 * in the V2 projections is guarded by inserting the event's own row, which a
 * unique constraint then makes replay-proof; a counter has no such row.
 *
 * So the counter is backed by rows. One row per emitted claim event, unique on
 * `(chainId, claimTxHash, claimLogIndex)`. The projector inserts the row first
 * and only then advances the allocation's total, so a replay hits the unique
 * constraint and becomes a no-op.
 *
 * The rows are also the reconciliation anchor the issue asks for: the sum of
 * withdrawal rows for an allocation must equal its `claimedAmount`, and that
 * equality is checkable with a single query. A mismatch means the counter and
 * the event log disagree, which is a fact about the projection worth surfacing
 * — never something to paper over by rewriting the counter.
 */
@Entity('v2_project_reward_claim')
@Unique('uq_v2_reward_claim_event', ['chainId', 'claimTxHash', 'claimLogIndex'])
@Index(['allocationId'])
@Index(['claimId'])
export class ProjectRewardClaim {
  /**
   * Deterministic withdrawal identity: the protocol's own when the event
   * supplies one, otherwise `chainId:txHash:logIndex` of the emitting event.
   */
  @PrimaryColumn({ type: 'varchar', length: 200 })
  withdrawalId: string;

  @Column({ type: 'int' })
  chainId: number;

  /** The allocation this withdrawal was attributed to. */
  @Column({ type: 'varchar', length: 200 })
  allocationId: string;

  /** The protocol claim the allocation belongs to. */
  @Column({ type: 'varchar', length: 66 })
  claimId: string;

  @Column({ type: 'varchar', length: 42, nullable: true })
  beneficiary: string | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  asset: string | null;

  /** Verbatim claimed amount from the event. Decimal string. */
  @Column({ type: 'varchar', length: 100 })
  amount: string;

  @Column({ type: 'varchar', length: 66 })
  claimTxHash: string;

  @Column({ type: 'int' })
  claimLogIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @CreateDateColumn()
  createdAt: Date;
}
