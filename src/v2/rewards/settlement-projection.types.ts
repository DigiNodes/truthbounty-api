import { AllocationKind } from './reward-allocation-kind.enum';
import { DataState } from '../common/data-state.enum';

/**
 * Pure, deterministic reward and settlement projection arithmetic.
 *
 * All operations use exact `bigint` integers. Floating-point numbers are strictly
 * forbidden to preserve 256-bit EVM precision without truncation errors.
 */

export const ROUNDING_POLICY = 'FLOOR_TRUNCATION_TO_ZERO' as const;

export const CANONICAL_SETTLEMENT_STATES = [
  'PENDING_SETTLEMENT',
  'SETTLED',
  'SETTLEMENT_CLAIMED',
  'PENDING_APPEAL',
  'APPEAL_SETTLED',
  'APPEAL_CLAIMED',
  'FINALIZED',
] as const;

export type CanonicalSettlementState =
  (typeof CANONICAL_SETTLEMENT_STATES)[number];

export interface AllocationProjectionItem {
  allocationId: string;
  kind: AllocationKind;
  beneficiary: string | null;
  allocatedAmount: string;
  claimedAmount: string;
  isFinalized?: boolean;
  isDisputed?: boolean;
}

export interface SettlementCalculationInput {
  fundedAmount: string;
  allocations: AllocationProjectionItem[];
  slashedAmount?: string;
  retainedDust?: string;
}

export interface ExactSettlementValues {
  funded: string;
  accrued: string;
  claimed: string;
  claimable: string;
  pending: string;
  slashed: string;
  refunded: string;
  dust: string;
}

export interface ConservationResult {
  reconciled: boolean;
  expectedFunded: string;
  actualFunded: string;
  delta: string;
  roundingPolicy: typeof ROUNDING_POLICY;
}

/**
 * Parse a base-10 integer string safely to bigint.
 * Fails closed on any non-integer or float input.
 */
export function toBigIntSafe(value: string | null | undefined, fieldName: string): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  const trimmed = value.trim();
  if (trimmed === '') return 0n;
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid integer representation for ${fieldName}: ${JSON.stringify(value)}`,
    );
  }
  return BigInt(trimmed);
}

/**
 * Pure calculation of settlement values with distinct claimable/pending/claimed segregation.
 */
export function calculateExactSettlementValues(
  input: SettlementCalculationInput,
): {
  values: ExactSettlementValues;
  conservation: ConservationResult;
  allocatedBreakdown: Array<{
    allocationId: string;
    kind: AllocationKind;
    beneficiary: string | null;
    allocated: string;
    claimed: string;
    claimable: string;
    pending: string;
    status: 'allocated' | 'partially_claimed' | 'claimed' | 'over_claimed';
  }>;
} {
  const funded = toBigIntSafe(input.fundedAmount, 'fundedAmount');
  const slashed = toBigIntSafe(input.slashedAmount, 'slashedAmount');

  let totalAccrued = 0n;
  let totalClaimed = 0n;
  let totalClaimable = 0n;
  let totalPending = 0n;
  let totalRefunded = 0n;

  const allocatedBreakdown = input.allocations.map((alloc) => {
    const allocated = toBigIntSafe(alloc.allocatedAmount, `allocatedAmount(${alloc.allocationId})`);
    const claimed = toBigIntSafe(alloc.claimedAmount, `claimedAmount(${alloc.allocationId})`);
    const remaining = allocated - claimed;

    totalClaimed += claimed;

    if (alloc.kind === AllocationKind.REFUND) {
      totalRefunded += allocated;
    } else {
      totalAccrued += allocated;
    }

    let claimable = 0n;
    let pending = 0n;

    if (remaining > 0n) {
      // Finalized allocations without active dispute are claimable; unfinalized/disputed are pending
      if (alloc.isFinalized && !alloc.isDisputed) {
        claimable = remaining;
        totalClaimable += claimable;
      } else {
        pending = remaining;
        totalPending += pending;
      }
    }

    let status: 'allocated' | 'partially_claimed' | 'claimed' | 'over_claimed';
    if (claimed < 0n || claimed > allocated) {
      status = 'over_claimed';
    } else if (claimed === 0n) {
      status = 'allocated';
    } else if (claimed === allocated) {
      status = 'claimed';
    } else {
      status = 'partially_claimed';
    }

    return {
      allocationId: alloc.allocationId,
      kind: alloc.kind,
      beneficiary: alloc.beneficiary,
      allocated: allocated.toString(),
      claimed: claimed.toString(),
      claimable: claimable.toString(),
      pending: pending.toString(),
      status,
    };
  });

  // Calculate dust: integer division remainder retained in contract
  let dust: bigint;
  if (input.retainedDust !== undefined) {
    dust = toBigIntSafe(input.retainedDust, 'retainedDust');
  } else {
    // If retained dust is not explicitly provided, dust is the unallocated portion of funded pool
    const totalAllocated = totalAccrued + totalRefunded;
    const computedDust = funded - (totalAllocated + slashed);
    dust = computedDust > 0n ? computedDust : 0n;
  }

  // Conservation check:
  // funded = claimed + claimable + pending + slashed + dust
  // Note: (accrued + refunded) = claimed + claimable + pending
  const expectedFunded = totalClaimed + totalClaimable + totalPending + slashed + dust;
  const delta = funded - expectedFunded;
  const reconciled = delta === 0n;

  return {
    values: {
      funded: funded.toString(),
      accrued: totalAccrued.toString(),
      claimed: totalClaimed.toString(),
      claimable: totalClaimable.toString(),
      pending: totalPending.toString(),
      slashed: slashed.toString(),
      refunded: totalRefunded.toString(),
      dust: dust.toString(),
    },
    conservation: {
      reconciled,
      expectedFunded: expectedFunded.toString(),
      actualFunded: funded.toString(),
      delta: delta.toString(),
      roundingPolicy: ROUNDING_POLICY,
    },
    allocatedBreakdown,
  };
}

/**
 * Split an integer pool across participant weights with explicit FLOOR_TRUNCATION_TO_ZERO.
 * Leaves residual dust accounted for without losing conservation.
 */
export function splitPoolWithRounding(
  totalPool: bigint,
  weights: bigint[],
): { shares: bigint[]; dust: bigint } {
  if (weights.length === 0 || totalPool === 0n) {
    return { shares: [], dust: totalPool };
  }
  const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
  if (totalWeight === 0n) {
    return { shares: weights.map(() => 0n), dust: totalPool };
  }

  let distributed = 0n;
  const shares = weights.map((weight) => {
    // Exact floor division
    const share = (totalPool * weight) / totalWeight;
    distributed += share;
    return share;
  });

  const dust = totalPool - distributed;
  return { shares, dust };
}
