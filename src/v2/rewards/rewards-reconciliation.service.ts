import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectRewardAllocation } from './entities/project-reward-allocation.entity';
import { ProjectRewardPool } from './entities/project-reward-pool.entity';
import { ProjectRewardClaim } from './entities/project-reward-claim.entity';
import {
  AllocationReconciliation,
  PoolReconciliation,
  reconcileAllocation,
  reconcilePool,
  sumAmounts,
} from './reward-reconciliation';
import { AllocationKind, ALLOCATION_KINDS } from './reward-allocation-kind.enum';

export interface AllocationWithdrawalReconciliation {
  allocationId: string;
  /** `claimedAmount` — the running total maintained by the projector. */
  claimedCounter: string;
  /** Sum of the withdrawal rows for this allocation. */
  claimedFromWithdrawals: string;
  /** `claimedCounter - claimedFromWithdrawals`. Un-clamped and signed. */
  divergence: string;
  /** True when the counter and the emitted claim events disagree. */
  divergent: boolean;
  withdrawalCount: number;
}

export interface RewardReconciliationReport {
  chainId: number;
  pools: PoolReconciliation[];
  allocations: AllocationReconciliation[];
  /** Counter-vs-event check for every allocation, in allocation-id order. */
  withdrawals: AllocationWithdrawalReconciliation[];
  summary: {
    poolCount: number;
    allocationCount: number;
    /** Pools whose projected allocations do not sum to the emitted total. */
    divergentPoolCount: number;
    /** Allocations whose tracked claims exceed the emitted allocation. */
    overClaimedAllocationCount: number;
    /**
     * Allocations whose `claimedAmount` counter disagrees with the sum of the
     * emitted `RewardClaimed` events attributed to them. Normally zero; a
     * non-zero value means the projection's counter and its event log have
     * diverged.
     */
    divergentWithdrawalCount: number;
    /** Allocations with no attributed claims yet. */
    unclaimedCount: number;
    /** Grand total of every projected allocation. Decimal string. */
    totalAllocated: string;
    /** Grand total of every tracked claim. Decimal string. */
    totalClaimed: string;
    /** Per-kind grand totals across every pool. */
    allocatedByKind: Record<AllocationKind, string>;
  };
}

/**
 * Read-side reconciliation of projected reward allocations against what the
 * contract actually emitted (V2-BE-017).
 *
 * ## What this service does and does not do
 *
 * It **reports** two independent facts and refuses to reconcile them by
 * fiat:
 *
 * 1. **Allocations vs source pools.** For each `RewardPoolSettled` pool, the
 *    sum of allocations projected from `RewardAllocated` events is compared
 *    against the pool amount the contract emitted. A difference is a
 *    `divergent` result.
 * 2. **Claimed vs claimable.** For each allocation, the tracked claims are
 *    compared against the allocated amount.
 *
 * When either diverges, the correct action is to investigate the *indexing*
 * path — a missed event, a quarantined log, an unmapped event name. It is
 * never correct to "fix" the numbers here. This service exposes no write
 * path at all: it has no method that mutates an allocation, a pool, or a
 * status. It is a read model about the read model.
 *
 * ## Why the projector never lets a divergence in
 *
 * The projector rejects a `RewardClaimed` that would exceed its allocation
 * (see `rewards-projector.service.ts`). So an `overClaimed` row here means the
 * state arrived by some path other than that projector — exactly the situation
 * a reconciliation pass exists to make loud rather than invisible.
 *
 * ## Determinism
 *
 * The report is a pure function of the projected rows: same rows in, same
 * report out, no clock, no randomness, no network. Rows are read in a fixed
 * order and every sum is exact `bigint` arithmetic (see
 * `reward-reconciliation.ts`).
 */
@Injectable()
export class RewardsReconciliationService {
  constructor(
    @InjectRepository(ProjectRewardAllocation)
    private readonly allocationRepo: Repository<ProjectRewardAllocation>,
    @InjectRepository(ProjectRewardPool)
    private readonly poolRepo: Repository<ProjectRewardPool>,
    @InjectRepository(ProjectRewardClaim)
    private readonly claimRepo: Repository<ProjectRewardClaim>,
  ) {}

  /**
   * Reconcile every pool and allocation for a chain.
   */
  async reconcileChain(chainId: number): Promise<RewardReconciliationReport> {
    const pools = await this.poolRepo.find({
      where: { chainId },
      order: { poolId: 'ASC' },
    });
    const allocations = await this.allocationRepo.find({
      where: { chainId },
      order: { allocationId: 'ASC' },
    });
    // Held in a local, not an instance field: this service is a singleton, so
    // per-call scratch state on `this` would be a data race the moment two
    // reconciliations overlap.
    const withdrawalsByAllocation = await this.sumWithdrawalsByAllocation(
      allocations.map((allocation) => allocation.allocationId),
    );
    const byPool = this.groupAllocationsByPool(allocations);
    const poolReconciliations = pools.map((pool) =>
      reconcilePool({
        poolId: pool.poolId,
        claimId: pool.claimId,
        asset: pool.asset,
        poolAmount: pool.poolAmount,
        allocations: byPool.get(pool.poolId) ?? [],
      }),
    );

    const allocationReconciliations = allocations.map((allocation) =>
      reconcileAllocation({
        allocationId: allocation.allocationId,
        kind: allocation.kind,
        beneficiary: allocation.beneficiary,
        allocatedAmount: allocation.allocatedAmount,
        claimedAmount: allocation.claimedAmount,
      }),
    );

    // The third check: the counter vs the emitted claim events. `claimedAmount`
    // is a running total and therefore the one value here that a bug could
    // silently corrupt; the withdrawal rows are the independent record it must
    // agree with.
    const withdrawals = allocations.map((allocation) => {
      const rows = withdrawalsByAllocation.get(allocation.allocationId) ?? {
        total: 0n,
        count: 0,
      };
      const divergence = BigInt(allocation.claimedAmount) - rows.total;
      return {
        allocationId: allocation.allocationId,
        claimedCounter: allocation.claimedAmount,
        claimedFromWithdrawals: rows.total.toString(),
        divergence: divergence.toString(),
        divergent: divergence !== 0n,
        withdrawalCount: rows.count,
      };
    });

    return {
      chainId,
      pools: poolReconciliations,
      allocations: allocationReconciliations,
      withdrawals,
      summary: this.summarise(
        poolReconciliations,
        allocationReconciliations,
        withdrawals,
        allocations,
      ),
    };
  }

  /**
   * Reconcile a single pool. Throws rather than returning an empty report, so
   * a caller asking about an unknown pool cannot mistake "no pool" for "a pool
   * with zero allocations, therefore balanced".
   */
  async reconcilePoolById(
    chainId: number,
    poolId: string,
  ): Promise<PoolReconciliation> {
    const pool = await this.poolRepo.findOne({ where: { chainId, poolId } });
    if (!pool) {
      throw new NotFoundException(
        `No reward pool ${poolId} projected on chain ${chainId}`,
      );
    }
    const allocations = await this.allocationRepo.find({
      where: { chainId, sourcePoolId: poolId },
      order: { allocationId: 'ASC' },
    });
    return reconcilePool({
      poolId: pool.poolId,
      claimId: pool.claimId,
      asset: pool.asset,
      poolAmount: pool.poolAmount,
      allocations,
    });
  }

  /** Every allocation for a claim, keyed by beneficiary class. */
  async listForClaim(
    chainId: number,
    claimId: string,
  ): Promise<RewardReconciliationReport['allocations']> {
    const allocations = await this.allocationRepo.find({
      where: { chainId, claimId },
      order: { allocationId: 'ASC' },
    });
    return allocations.map((allocation) =>
      reconcileAllocation({
        allocationId: allocation.allocationId,
        kind: allocation.kind,
        beneficiary: allocation.beneficiary,
        allocatedAmount: allocation.allocatedAmount,
        claimedAmount: allocation.claimedAmount,
      }),
    );
  }

  /** Every allocation for one beneficiary class across a chain. */
  async listByKind(
    chainId: number,
    kind: AllocationKind,
  ): Promise<ProjectRewardAllocation[]> {
    return this.allocationRepo.find({
      where: { chainId, kind },
      order: { allocationId: 'ASC' },
    });
  }

  /**
   * Exact `bigint` sum of the withdrawal rows per allocation.
   *
   * Read in a single ordered query rather than N per-allocation queries, so the
   * report costs the same regardless of how many allocations exist. Amounts are
   * summed as `bigint`; a malformed stored amount throws here rather than being
   * silently dropped, because a silently dropped withdrawal would look exactly
   * like a counter that drifted.
   */
  private async sumWithdrawalsByAllocation(
    allocationIds: string[],
  ): Promise<Map<string, { total: bigint; count: number }>> {
    const totals = new Map<string, { total: bigint; count: number }>();
    if (allocationIds.length === 0) return totals;

    const rows = await this.claimRepo
      .createQueryBuilder('w')
      .where('w.allocationId IN (:...allocationIds)', { allocationIds })
      .orderBy('w.allocationId', 'ASC')
      .addOrderBy('w.claimTxHash', 'ASC')
      .addOrderBy('w.claimLogIndex', 'ASC')
      .getMany();

    for (const row of rows) {
      const amount = BigInt(row.amount);
      const existing = totals.get(row.allocationId);
      if (existing) {
        existing.total += amount;
        existing.count += 1;
      } else {
        totals.set(row.allocationId, { total: amount, count: 1 });
      }
    }
    return totals;
  }

  private groupAllocationsByPool(    allocations: ProjectRewardAllocation[],
  ): Map<string, ProjectRewardAllocation[]> {
    const grouped = new Map<string, ProjectRewardAllocation[]>();
    for (const allocation of allocations) {
      const bucket = grouped.get(allocation.sourcePoolId);
      if (bucket) {
        bucket.push(allocation);
      } else {
        grouped.set(allocation.sourcePoolId, [allocation]);
      }
    }
    return grouped;
  }

  private async summarise(
    pools: PoolReconciliation[],
    allocations: AllocationReconciliation[],
    withdrawals: AllocationWithdrawalReconciliation[],
    rows: ProjectRewardAllocation[],
  ): RewardReconciliationReport['summary'] {
    const kindTotals = new Map<AllocationKind, bigint>();
    for (const kind of ALLOCATION_KINDS) {
      kindTotals.set(kind, 0n);
    }
    for (const row of rows) {
      kindTotals.set(
        row.kind,
        (kindTotals.get(row.kind) ?? 0n) + BigInt(row.allocatedAmount),
      );
    }
    const allocatedByKind = {} as Record<AllocationKind, string>;
    for (const kind of ALLOCATION_KINDS) {
      allocatedByKind[kind] = (kindTotals.get(kind) ?? 0n).toString();
    }

    return {
      poolCount: pools.length,
      allocationCount: allocations.length,
      divergentPoolCount: pools.filter((pool) => pool.divergent).length,
      overClaimedAllocationCount: allocations.filter((a) => a.overClaimed)
        .length,
      divergentWithdrawalCount: withdrawals.filter((w) => w.divergent).length,
      unclaimedCount: allocations.filter((a) => a.claimed === '0').length,
      totalAllocated: sumAmounts(allocations.map((a) => a.allocated)),
      totalClaimed: sumAmounts(allocations.map((a) => a.claimed)),
      allocatedByKind,
    };
  }
}
