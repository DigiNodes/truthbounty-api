import { AllocationKind, parseAllocationKind } from './reward-allocation-kind.enum';
import {
  classifyAllocationStatus,
  reconcileAllocation,
  reconcilePool,
  sumAmounts,
} from './reward-reconciliation';

/**
 * Pure unit tests for the reconciliation arithmetic. No Nest, no TypeORM, no
 * database — these functions are total and side-effect free precisely so that
 * they can be exercised this cheaply and this exhaustively.
 */
describe('reward reconciliation arithmetic', () => {
  describe('parseAllocationKind', () => {
    it('accepts each of the five protocol beneficiary classes', () => {
      expect(parseAllocationKind('submitter')).toBe(AllocationKind.SUBMITTER);
      expect(parseAllocationKind('verifier')).toBe(AllocationKind.VERIFIER);
      expect(parseAllocationKind('challenger')).toBe(AllocationKind.CHALLENGER);
      expect(parseAllocationKind('treasury')).toBe(AllocationKind.TREASURY);
      expect(parseAllocationKind('refund')).toBe(AllocationKind.REFUND);
    });

    it('normalises case and surrounding whitespace', () => {
      expect(parseAllocationKind('  Verifier ')).toBe(AllocationKind.VERIFIER);
      expect(parseAllocationKind('TREASURY')).toBe(AllocationKind.TREASURY);
    });

    it('returns null for an unrecognised or absent kind rather than defaulting', () => {
      expect(parseAllocationKind('slashed')).toBeNull();
      expect(parseAllocationKind('')).toBeNull();
      expect(parseAllocationKind(null)).toBeNull();
    });
  });

  describe('classifyAllocationStatus', () => {
    it('reports "allocated" when nothing has been claimed', () => {
      expect(classifyAllocationStatus(1000n, 0n)).toBe('allocated');
    });

    it('reports "partially_claimed" for a partial claim', () => {
      expect(classifyAllocationStatus(1000n, 1n)).toBe('partially_claimed');
      expect(classifyAllocationStatus(1000n, 999n)).toBe('partially_claimed');
    });

    it('reports "claimed" at exactly the allocated amount', () => {
      expect(classifyAllocationStatus(1000n, 1000n)).toBe('claimed');
    });

    it('reports "over_claimed" beyond the allocated amount, never clamping', () => {
      expect(classifyAllocationStatus(1000n, 1001n)).toBe('over_claimed');
    });
  });

  describe('reconcileAllocation', () => {
    const row = (overrides: Partial<Parameters<typeof reconcileAllocation>[0]>) =>
      reconcileAllocation({
        allocationId: 'alloc-1',
        kind: AllocationKind.VERIFIER,
        beneficiary: '0x' + '22'.repeat(20),
        allocatedAmount: '1000',
        claimedAmount: '0',
        ...overrides,
      });

    it('computes the remaining claimable amount with exact integer math', () => {
      const result = row({ claimedAmount: '250' });
      expect(result.claimableRemaining).toBe('750');
      expect(result.divergent).toBe(false);
      expect(result.status).toBe('partially_claimed');
    });

    it('keeps a negative remainder visible instead of clamping it to zero', () => {
      const result = row({ claimedAmount: '1500' });
      expect(result.claimableRemaining).toBe('-500');
      expect(result.overClaimed).toBe(true);
      expect(result.divergent).toBe(true);
      expect(result.status).toBe('over_claimed');
    });

    it('is exact well past Number.MAX_SAFE_INTEGER', () => {
      // 2^256-ish territory. A float-based implementation silently loses the
      // low digits here; bigint arithmetic must not.
      const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
      const result = row({ allocatedAmount: huge, claimedAmount: '1' });
      expect(result.claimableRemaining).toBe(
        (
          BigInt(huge) - 1n
        ).toString(),
      );
      expect(result.claimed).toBe('1');
    });

    it('throws on a non-integer amount rather than coercing it to zero', () => {
      expect(() => row({ allocatedAmount: '1.5' })).toThrow(
        /base-10 integer string/,
      );
      expect(() => row({ claimedAmount: '1e18' })).toThrow(
        /base-10 integer string/,
      );
      expect(() => row({ claimedAmount: '' })).toThrow(/base-10 integer string/);
    });
  });

  describe('reconcilePool', () => {
    const pool = (overrides: Partial<Parameters<typeof reconcilePool>[0]>) =>
      reconcilePool({
        poolId: 'pool-1',
        claimId: '0x' + '11'.repeat(32),
        asset: '0x' + '33'.repeat(20),
        poolAmount: '10000',
        allocations: [],
        ...overrides,
      });

    it('reports balance when the allocations sum to the emitted pool amount', () => {
      const result = pool({
        allocations: [
          { kind: AllocationKind.SUBMITTER, allocatedAmount: '6000' },
          { kind: AllocationKind.VERIFIER, allocatedAmount: '2500' },
          { kind: AllocationKind.CHALLENGER, allocatedAmount: '1000' },
          { kind: AllocationKind.TREASURY, allocatedAmount: '500' },
        ],
      });

      expect(result.allocatedTotal).toBe('10000');
      expect(result.divergence).toBe('0');
      expect(result.divergent).toBe(false);
      expect(result.allocationCount).toBe(4);
    });

    it('breaks the pool down by beneficiary class', () => {
      const result = pool({
        allocations: [
          { kind: AllocationKind.SUBMITTER, allocatedAmount: '6000' },
          { kind: AllocationKind.REFUND, allocatedAmount: '4000' },
        ],
      });

      expect(result.byKind[AllocationKind.SUBMITTER]).toBe('6000');
      expect(result.byKind[AllocationKind.REFUND]).toBe('4000');
      expect(result.byKind[AllocationKind.VERIFIER]).toBe('0');
      expect(result.byKind[AllocationKind.CHALLENGER]).toBe('0');
      expect(result.byKind[AllocationKind.TREASURY]).toBe('0');
    });

    it('reports a signed divergence when allocations under-account for the pool', () => {
      const result = pool({
        allocations: [
          { kind: AllocationKind.SUBMITTER, allocatedAmount: '6000' },
        ],
      });

      expect(result.allocatedTotal).toBe('6000');
      expect(result.divergence).toBe('4000');
      expect(result.divergent).toBe(true);
    });

    it('reports a negative divergence when allocations over-account for the pool', () => {
      const result = pool({
        poolAmount: '1000',
        allocations: [
          { kind: AllocationKind.SUBMITTER, allocatedAmount: '1500' },
        ],
      });

      expect(result.divergence).toBe('-500');
      expect(result.divergent).toBe(true);
    });

    it('treats a pool with no projected allocations as divergent, not balanced', () => {
      const result = pool({ allocations: [] });
      expect(result.allocatedTotal).toBe('0');
      expect(result.divergence).toBe('10000');
      expect(result.divergent).toBe(true);
    });

    it('treats a zero-value pool with no allocations as balanced', () => {
      const result = pool({ poolAmount: '0', allocations: [] });
      expect(result.divergent).toBe(false);
    });
  });

  describe('sumAmounts', () => {
    it('rejects decimal fractions outright, so no float arithmetic is reachable', () => {
      expect(() => sumAmounts(['0.1', '0.2'])).toThrow(/base-10 integer string/);
    });

    it('sums an empty list to zero', () => {
      expect(sumAmounts([])).toBe('0');
    });

    it('sums values beyond double precision exactly', () => {
      expect(
        sumAmounts([
          '9007199254740993', // 2^53 + 1, not representable as a double
          '1',
        ]),
      ).toBe('9007199254740994');
    });

    it('rejects a non-integer entry rather than silently dropping it', () => {
      expect(() => sumAmounts(['1', 'nope'])).toThrow(/base-10 integer string/);
    });
  });
});
