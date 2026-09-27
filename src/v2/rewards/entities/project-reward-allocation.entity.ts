import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { AllocationKind } from '../reward-allocation-kind.enum';

/**
 * A single reward allocation, projected from a canonical `RewardAllocated`
 * event, plus the claim progress the contract has since emitted for it.
 *
 * ## What this table is allowed to know
 *
 * - `allocatedAmount` is the amount the contract said this beneficiary was
 *   allocated. It is stored **verbatim** from the event's `amount` field and is
 *   never recomputed, apportioned, or adjusted.
 * - `claimedAmount` is the running sum of amounts from `RewardClaimed` events
 *   that the contract has already emitted for this allocation. It is *tracked*,
 *   not predicted: it moves only when a `RewardClaimed` event exists.
 * - `status` is a pure function of the two amounts above
 *   (see `reward-reconciliation.ts`). It carries no independent meaning.
 *
 * ## What this table must never do
 *
 * It must never decide *who won*, *how much anyone is owed*, or *whether a
 * claim is legitimately payable*. Those are settled on-chain. If the contract
 * has not emitted an allocation, this table has no row and the API has no
 * opinion; if the contract has emitted a claim this projector cannot attribute,
 * that is an indexing anomaly, not something to infer a beneficiary from.
 *
 * ## Amount representation
 *
 * Decimal **strings** in `varchar(100)`, matching the rest of the V2 read
 * models (`ProjectParticipantPosition.stake`, `ProjectDispute.challengeBond`,
 * `CanonicalEvent.amount`). Never a float, never a JS number — a 256-bit
 * `uint256` amount does not survive either. All arithmetic on these values is
 * `bigint`, and it happens in `reward-reconciliation.ts`.
 */
@Entity('v2_project_reward_allocation')
export class ProjectRewardAllocation {
  /**
   * Protocol-supplied allocation id when the event carries one, otherwise a
   * deterministic derivation from the creating event's identity
   * (`chainId:txHash:logIndex`). Either way the value is a pure function of
   * chain data, so a replay reconstructs the identical key.
   */
  @PrimaryColumn({ type: 'varchar', length: 200 })
  allocationId: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 66 })
  claimId: string;

  @Column({ type: 'varchar', length: 66, nullable: true })
  roundId: string | null;

  /** The emitted source pool this allocation draws from. Reconciliation key. */
  @Column({ type: 'varchar', length: 200 })
  sourcePoolId: string;

  @Column({ type: 'varchar', length: 16 })
  kind: AllocationKind;

  /**
   * The party the allocation is for. `null` for protocol sinks such as the
   * treasury, which is not an externally-owned account. Never invented: this is
   * the event's `beneficiary`, lowercased, or `null` when the event has none.
   */
  @Column({ type: 'varchar', length: 42, nullable: true })
  beneficiary: string | null;

  @Column({ type: 'varchar', length: 42 })
  asset: string;

  /** Verbatim amount from the `RewardAllocated` event. Decimal string. */
  @Column({ type: 'varchar', length: 100 })
  allocatedAmount: string;

  /**
   * Running sum of amounts from attributed `RewardClaimed` events. Decimal
   * string. The projector rejects any claim that would push this above
   * `allocatedAmount`, so this column never exceeds it.
   */
  @Column({ type: 'varchar', length: 100, default: '0' })
  claimedAmount: string;

  /** Block of the most recent `RewardClaimed` event attributed to this row. */
  @Column({ type: 'bigint', nullable: true })
  lastClaimBlockNumber: string | null;

  /** `txHash:logIndex` of the most recent attributed claim, for auditing. */
  @Column({ type: 'varchar', length: 140, nullable: true })
  lastClaimEvent: string | null;

  /** Identity of the `RewardAllocated` event that created this row. */
  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
