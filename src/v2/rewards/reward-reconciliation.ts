import { AllocationKind, ALLOCATION_KINDS } from './reward-allocation-kind.enum';

/**
 * Pure, deterministic reward-allocation reconciliation arithmetic.
 *
 * Every function here is total, side-effect free, and operates on `bigint` or
 * decimal strings. There is deliberately **no** code in this file that reads a
 * clock, touches a database, or reaches for the network — which is what makes
 * the reconciliation report reproducible: same projection rows in, same report
 * out, byte for byte.
 *
 * ## Why `bigint` and not a decimal library
 *
 * The chain's amounts are 256-bit integers. `number` loses precision above
 * 2^53; `parseFloat` loses it far earlier. The repository's V2 read models
 * already store these values as decimal strings in `varchar(100)` (see
 * `ProjectParticipantPosition.stake`, `CanonicalEvent.amount`), so this module
 * parses to `bigint`, does exact integer arithmetic, and serialises back with
 * `toString()`. No float ever touches a token amount.
 *
 * ## What "divergent" means here
 *
 * Divergence is *reported*, never *repaired*. A pool whose allocations do not
 * sum to the emitted pool amount, or an allocation whose claims exceed its
 * allocation, is a fact about the chain that this service does not get to
 * overrule. The projector is careful never to create that state in the first
 * place (it rejects the offending event and records an anomaly); these
 * functions exist so a divergence that arrives some other way is still visible
 * rather than invisible.
 */

/** Throw on anything that is not a base-10 integer string. */
function toBigInt(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `${field} must be a base-10 integer string, received ${JSON.stringify(value)}`,
    );
  }
  return BigInt(trimmed);
}

export type AllocationStatus = 'allocated' | 'partially_claimed' | 'claimed';

export interface AllocationAmounts {
  allocationId: string;
  kind: AllocationKind;
  beneficiary: string | null;
  /** Verbatim amount from the allocating event. */
  allocatedAmount: string;
  /** Running sum of amounts from attributed claim events. */
  claimedAmount: string;
}

export interface AllocationReconciliation {
  allocationId: string;
  kind: AllocationKind;
  beneficiary: string | null;
  /** The contract-emitted allocation. */
  allocated: string;
  /** The contract-emitted claims so far. */
  claimed: string;
  /**
   * `allocated - claimed`. Reported raw and **not** clamped to zero: a negative
   * value is the signal that must stay visible. See {@link overClaimed}.
   */
  claimableRemaining: string;
  /** True when `claimed > allocated` — an invariant violation. */
  overClaimed: boolean;
  status: AllocationStatus | 'over_claimed';
  /** True when anything at all is off. */
  divergent: boolean;
}

/**
 * Derive the read status from the two amounts. Pure: no event history, no
 * contract semantics, just "how much of it has been claimed".
 */
export function classifyAllocationStatus(
  allocated: bigint,
  claimed: bigint,
): AllocationStatus | 'over_claimed' {
  if (claimed < 0n) return 'over_claimed';
  if (claimed > allocated) return 'over_claimed';
  if (claimed === 0n) return 'allocated';
  if (claimed === allocated) return 'claimed';
  return 'partially_claimed';
}

/**
 * Reconcile one allocation's allocated vs claimed amounts.
 *
 * @throws if either amount is not a base-10 integer string. A malformed
 *         amount is a data defect that must surface, not coerce to `0`.
 */
export function reconcileAllocation(
  row: AllocationAmounts,
): AllocationReconciliation {
  const allocated = toBigInt(row.allocatedAmount, 'allocatedAmount');
  const claimed = toBigInt(row.claimedAmount, 'claimedAmount');
  const overClaimed = claimed > allocated || claimed < 0n;

  return {
    allocationId: row.allocationId,
    kind: row.kind,
    beneficiary: row.beneficiary,
    allocated: allocated.toString(),
    claimed: claimed.toString(),
    // Left un-clamped on purpose: a negative remainder is the whole point.
    claimableRemaining: (allocated - claimed).toString(),
    overClaimed,
    status: classifyAllocationStatus(allocated, claimed),
    divergent: overClaimed,
  };
}

export interface PoolReconciliationInput {
  poolId: string;
  claimId: string;
  asset: string;
  /** Verbatim settled amount emitted by the contract. */
  poolAmount: string;
  /** Every projected allocation that draws from this pool. */
  allocations: ReadonlyArray<
    Pick<AllocationAmounts, 'allocatedAmount' | 'kind'>
  >;
}

export interface PoolReconciliation {
  poolId: string;
  claimId: string;
  asset: string;
  /** The contract-emitted pool total. */
  poolAmount: string;
  /** Sum of the allocations projected against this pool. */
  allocatedTotal: string;
  /** `poolAmount - allocatedTotal`. Un-clamped and signed. */
  divergence: string;
  /** True when the projected allocations do not sum to the emitted total. */
  divergent: boolean;
  /** Per-kind subtotals, keyed by {@link AllocationKind}. */
  byKind: Record<AllocationKind, string>;
  allocationCount: number;
}

/**
 * Compare a source pool's emitted total against the allocations projected from
 * it, and break the allocations down by beneficiary class.
 *
 * This is a *check*, never a *correction*. A `divergent: true` result means the
 * database disagrees with the chain, and the correct response is to investigate
 * the indexing path — not to adjust either side to make the numbers line up.
 */
export function reconcilePool(
  input: PoolReconciliationInput,
): PoolReconciliation {
  const poolAmount = toBigInt(input.poolAmount, 'poolAmount');

  const byKindTotals = new Map<AllocationKind, bigint>();
  for (const kind of ALLOCATION_KINDS) {
    byKindTotals.set(kind, 0n);
  }

  let allocatedTotal = 0n;
  for (const allocation of input.allocations) {
    const amount = toBigInt(allocation.allocatedAmount, 'allocatedAmount');
    allocatedTotal += amount;
    byKindTotals.set(
      allocation.kind,
      (byKindTotals.get(allocation.kind) ?? 0n) + amount,
    );
  }

  const byKind = {} as Record<AllocationKind, string>;
  for (const kind of ALLOCATION_KINDS) {
    byKind[kind] = (byKindTotals.get(kind) ?? 0n).toString();
  }

  return {
    poolId: input.poolId,
    claimId: input.claimId,
    asset: input.asset,
    poolAmount: poolAmount.toString(),
    allocatedTotal: allocatedTotal.toString(),
    divergence: (poolAmount - allocatedTotal).toString(),
    divergent: poolAmount !== allocatedTotal,
    byKind,
    allocationCount: input.allocations.length,
  };
}

/**
 * Sum a set of decimal strings exactly. Used for the report's grand totals.
 */
export function sumAmounts(values: ReadonlyArray<string>): string {
  let total = 0n;
  for (const value of values) {
    total += toBigInt(value, 'amount');
  }
  return total.toString();
}
