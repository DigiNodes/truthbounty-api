import { createHash } from 'node:crypto';

/**
 * Pure, deterministic stake lock, unlock, slash, and withdrawal projection arithmetic.
 *
 * All operations use exact `bigint` integers. Floating-point numbers are strictly
 * forbidden to preserve 256-bit EVM precision without truncation errors.
 */

export const ROUNDING_POLICY = 'FLOOR_TRUNCATION_TO_ZERO' as const;

export const CANONICAL_STAKE_STATES = [
  'ACTIVE',
  'LOCKED',
  'PARTIALLY_LOCKED',
  'PENDING_WITHDRAWAL',
  'SLASHED',
  'WITHDRAWN',
  'FINALIZED',
] as const;

export type CanonicalStakeState = (typeof CANONICAL_STAKE_STATES)[number];

export type LockPhase = 'COMMITMENT' | 'REVEAL' | 'SETTLEMENT' | 'APPEAL';

export type LockStatus = 'ACTIVE' | 'EXPIRED' | 'UNLOCKED' | 'SLASHED' | 'APPEAL_CARRIED';

export type PayoutStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'RETRYABLE';

/**
 * Source provenance reference for every chain-derived balance or state.
 */
export interface SourceReference {
  eventType: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash?: string;
  chainId: number;
  releaseId: string;
  artifactChecksum: string;
}

/**
 * A time-lock or round-lock on a staker's balance.
 */
export interface StakeLockItem {
  lockId: string;
  claimId: string;
  roundId?: string | null;
  walletAddress: string;
  amount: string;
  unlocksAt: number; // Unix timestamp in seconds
  phase?: LockPhase;
  status: LockStatus;
  reason?: string | null;
  isAppealCarry?: boolean;
  source?: SourceReference;
}

/**
 * Recorded withdrawal or payout projection.
 */
export interface PayoutProjectionItem {
  payoutId: string;
  claimId: string;
  walletAddress: string;
  amount: string;
  status: PayoutStatus;
  retryable: boolean;
  failureReason?: string | null;
  retryCount: number;
  txHash?: string | null;
  blockNumber?: number;
  createdAt: string;
  updatedAt: string;
  source?: SourceReference;
}

/**
 * Slash event projection.
 */
export interface StakeSlashItem {
  slashId: string;
  claimId: string;
  walletAddress: string;
  amount: string;
  reason: string;
  roundId?: string | null;
  blockNumber: number;
  txHash: string;
  source?: SourceReference;
}

/**
 * Input for exact stake balance calculation.
 */
export interface StakeCalculationInput {
  totalStaked: string;
  locks: StakeLockItem[];
  payouts: PayoutProjectionItem[];
  slashes: StakeSlashItem[];
  retainedDust?: string;
  currentTimeSec?: number;
}

/**
 * Exact stake balances in wei.
 */
export interface ExactStakeBalances {
  /** Total raw deposited stake */
  totalStaked: string;
  /** Available / withdrawable stake (unencumbered) */
  available: string;
  /** Active locked funds (time locks + round locks + appeal carry) */
  locked: string;
  /** Expired locks that are pending unlock or release */
  expiredLocked: string;
  /** Pending or retryable payouts in flight */
  pendingWithdrawal: string;
  /** Cumulative slashed stake */
  slashed: string;
  /** Cumulative completed withdrawals */
  withdrawn: string;
  /** Retained contract dust */
  dust: string;
}

/**
 * Conservation result proving conservation of funds.
 */
export interface StakeConservationResult {
  reconciled: boolean;
  expectedTotal: string;
  actualTotal: string;
  delta: string;
  digest: string;
  roundingPolicy: typeof ROUNDING_POLICY;
}

/**
 * Parse a base-10 integer string safely to bigint.
 * Fails closed on any non-integer, negative, or float input when nonNegative=true.
 */
export function toBigIntSafe(
  value: string | number | bigint | null | undefined,
  fieldName: string,
  options?: { allowNegative?: boolean },
): bigint {
  if (value === null || value === undefined) {
    return 0n;
  }
  if (typeof value === 'bigint') {
    if (!options?.allowNegative && value < 0n) {
      throw new Error(`Negative value not allowed for ${fieldName}: ${value.toString()}`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`Invalid integer representation for ${fieldName}: ${value}`);
    }
    const b = BigInt(value);
    if (!options?.allowNegative && b < 0n) {
      throw new Error(`Negative value not allowed for ${fieldName}: ${b.toString()}`);
    }
    return b;
  }
  const trimmed = value.trim();
  if (trimmed === '') return 0n;
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid integer representation for ${fieldName}: ${JSON.stringify(value)}`,
    );
  }
  const result = BigInt(trimmed);
  if (!options?.allowNegative && result < 0n) {
    throw new Error(`Negative value not allowed for ${fieldName}: ${trimmed}`);
  }
  return result;
}

/**
 * Pure calculation of stake balances with strict segregation.
 *
 * Invariant:
 * totalStaked = available + locked + expiredLocked + pendingWithdrawal + slashed + withdrawn + dust
 *
 * Rules:
 * 1. Locked funds NEVER appear in available/withdrawable.
 * 2. Failed payouts remain in pendingWithdrawal with retryable=true.
 * 3. Over-unlocks are strictly prevented.
 * 4. Exact 256-bit integer math without floats.
 */
export function calculateExactStakeBalances(input: StakeCalculationInput): {
  balances: ExactStakeBalances;
  conservation: StakeConservationResult;
  roundLocks: StakeLockItem[];
  retryablePayouts: PayoutProjectionItem[];
} {
  const totalStaked = toBigIntSafe(input.totalStaked, 'totalStaked');
  const nowSec = input.currentTimeSec ?? Math.floor(Date.now() / 1000);

  let activeLocked = 0n;
  let expiredLocked = 0n;
  const processedLocks: StakeLockItem[] = [];

  for (const lock of input.locks) {
    const lockAmount = toBigIntSafe(lock.amount, `lock.amount(${lock.lockId})`);
    if (lockAmount === 0n) continue;

    const isStillLocked = lock.isAppealCarry || lock.unlocksAt > nowSec;
    let status: LockStatus = lock.status;

    if (lock.status !== 'SLASHED' && lock.status !== 'UNLOCKED') {
      if (lock.isAppealCarry) {
        status = 'APPEAL_CARRIED';
        activeLocked += lockAmount;
      } else if (isStillLocked) {
        status = 'ACTIVE';
        activeLocked += lockAmount;
      } else {
        status = 'EXPIRED';
        expiredLocked += lockAmount;
      }
    }

    processedLocks.push({
      ...lock,
      status,
    });
  }

  // Calculate slashes
  let totalSlashed = 0n;
  for (const slash of input.slashes) {
    const amount = toBigIntSafe(slash.amount, `slash.amount(${slash.slashId})`);
    totalSlashed += amount;
  }

  // Calculate payouts: completed (withdrawn) vs pending/retryable
  let totalWithdrawn = 0n;
  let totalPendingWithdrawal = 0n;
  const retryablePayouts: PayoutProjectionItem[] = [];

  for (const payout of input.payouts) {
    const amount = toBigIntSafe(payout.amount, `payout.amount(${payout.payoutId})`);
    if (payout.status === 'COMPLETED') {
      totalWithdrawn += amount;
    } else if (payout.status === 'FAILED' || payout.status === 'RETRYABLE') {
      totalPendingWithdrawal += amount;
      retryablePayouts.push({
        ...payout,
        status: 'RETRYABLE',
        retryable: true,
      });
    } else if (payout.status === 'PENDING') {
      totalPendingWithdrawal += amount;
    }
  }

  // Calculate dust
  let dust = 0n;
  if (input.retainedDust !== undefined) {
    dust = toBigIntSafe(input.retainedDust, 'retainedDust');
  }

  // Available = totalStaked - (activeLocked + expiredLocked + totalPendingWithdrawal + totalSlashed + totalWithdrawn + dust)
  const encumbered =
    activeLocked +
    expiredLocked +
    totalPendingWithdrawal +
    totalSlashed +
    totalWithdrawn +
    dust;

  let available = 0n;
  if (totalStaked >= encumbered) {
    available = totalStaked - encumbered;
  } else {
    available = 0n;
  }

  // Conservation check:
  const expectedTotal =
    available +
    activeLocked +
    expiredLocked +
    totalPendingWithdrawal +
    totalSlashed +
    totalWithdrawn +
    dust;

  const delta = totalStaked - expectedTotal;
  const reconciled = delta === 0n;

  // Compute deterministic SHA-256 conservation digest
  const digestPayload = JSON.stringify({
    actualTotal: totalStaked.toString(),
    available: available.toString(),
    delta: delta.toString(),
    dust: dust.toString(),
    expectedTotal: expectedTotal.toString(),
    expiredLocked: expiredLocked.toString(),
    locked: activeLocked.toString(),
    pendingWithdrawal: totalPendingWithdrawal.toString(),
    reconciled,
    roundingPolicy: ROUNDING_POLICY,
    slashed: totalSlashed.toString(),
    withdrawn: totalWithdrawn.toString(),
  });

  const digest = createHash('sha256').update(digestPayload).digest('hex');

  return {
    balances: {
      totalStaked: totalStaked.toString(),
      available: available.toString(),
      locked: activeLocked.toString(),
      expiredLocked: expiredLocked.toString(),
      pendingWithdrawal: totalPendingWithdrawal.toString(),
      slashed: totalSlashed.toString(),
      withdrawn: totalWithdrawn.toString(),
      dust: dust.toString(),
    },
    conservation: {
      reconciled,
      expectedTotal: expectedTotal.toString(),
      actualTotal: totalStaked.toString(),
      delta: delta.toString(),
      digest,
      roundingPolicy: ROUNDING_POLICY,
    },
    roundLocks: processedLocks,
    retryablePayouts,
  };
}
