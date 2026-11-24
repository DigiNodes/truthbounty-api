import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  SettlementProjectionService,
  CANONICAL_RELEASE_METADATA,
  AUTHORITY_DISCLAIMER,
} from './settlement-projection.service';
import {
  calculateExactSettlementValues,
  splitPoolWithRounding,
  toBigIntSafe,
  ROUNDING_POLICY,
  CANONICAL_SETTLEMENT_STATES,
} from './settlement-projection.types';
import { AllocationKind } from './reward-allocation-kind.enum';
import { DataState } from '../common/data-state.enum';
import { DisputeStatus } from '../disputes/entities/project-dispute.entity';
import { StaleReconciliationException } from './exceptions/stale-reconciliation.exception';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';

describe('SettlementProjectionService (PREWAVE-BE-064)', () => {
  let service: SettlementProjectionService;
  let mockPoolRepo: any;
  let mockAllocationRepo: any;
  let mockClaimRepo: any;
  let mockCheckpointRepo: any;
  let mockRoundRepo: any;
  let mockDisputeRepo: any;
  let mockBlockchainState: any;
  let mockFinalityPolicy: any;

  beforeEach(() => {
    mockPoolRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    mockAllocationRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockClaimRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockCheckpointRepo = {
      findOne: jest.fn().mockResolvedValue({
        chainId: 11155420,
        lastIndexedBlock: '18450100',
        lastSafeBlock: '18450099',
        lastFinalizedBlock: '18450080',
      }),
    };
    mockRoundRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockDisputeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    mockBlockchainState = {
      getIndexerHealth: jest.fn().mockResolvedValue({
        status: 'healthy',
        indexerLagBlocks: 2,
        observedHeadBlock: 18450102,
        projectionHeadBlock: 18450100,
        safeBlock: 18450099,
        finalizedBlock: 18450080,
      }),
    };
    mockFinalityPolicy = {
      classifyByCheckpoint: jest.fn().mockImplementation((block, checkpoint) => {
        if (!checkpoint) return DataState.OBSERVED;
        const b = BigInt(block);
        if (b <= BigInt(checkpoint.lastFinalizedBlock)) return DataState.FINALIZED;
        if (b <= BigInt(checkpoint.lastSafeBlock)) return DataState.SAFE;
        return DataState.OBSERVED;
      }),
      isFinalized: jest.fn().mockImplementation((state) => state === DataState.FINALIZED),
      isProvisional: jest.fn().mockImplementation((state) => state !== DataState.FINALIZED),
    };

    service = new SettlementProjectionService(
      mockPoolRepo,
      mockAllocationRepo,
      mockClaimRepo,
      mockCheckpointRepo,
      mockRoundRepo,
      mockDisputeRepo,
      mockBlockchainState,
      mockFinalityPolicy,
    );
  });

  // ---------------------------------------------------------------------------
  // 1. Exact Integer Preservation
  // ---------------------------------------------------------------------------
  describe('Exact Integer Preservation', () => {
    it('preserves exact 256-bit integer quantities without float precision loss', () => {
      // 1 billion ETH in wei (well beyond 2^53 JavaScript Number.MAX_SAFE_INTEGER)
      const bigAmount1 = '1000000000000000000000000000';
      const bigAmount2 = '500000000000000000000000001';
      const result = calculateExactSettlementValues({
        fundedAmount: bigAmount1,
        allocations: [
          {
            allocationId: 'alloc-big-1',
            kind: AllocationKind.VERIFIER,
            beneficiary: '0x1111111111111111111111111111111111111111',
            allocatedAmount: bigAmount2,
            claimedAmount: '1',
            isFinalized: true,
          },
        ],
      });

      expect(result.values.funded).toBe(bigAmount1);
      expect(result.values.accrued).toBe(bigAmount2);
      expect(result.values.claimed).toBe('1');
      expect(result.values.claimable).toBe('500000000000000000000000000');
      expect(result.conservation.reconciled).toBe(true);
      expect(result.conservation.delta).toBe('0');
    });

    it('fails closed on any non-integer or float input string', () => {
      expect(() => toBigIntSafe('100.5', 'amount')).toThrow(
        /Invalid integer representation/,
      );
      expect(() => toBigIntSafe('NaN', 'amount')).toThrow(
        /Invalid integer representation/,
      );
      expect(() => toBigIntSafe('1e18', 'amount')).toThrow(
        /Invalid integer representation/,
      );
      expect(() => toBigIntSafe('0x123', 'amount')).toThrow(
        /Invalid integer representation/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Pending, Claimable, and Paid (Claimed) Segregation
  // ---------------------------------------------------------------------------
  describe('Segregation of Pending, Claimable, and Paid', () => {
    it('keeps pending, claimable, and claimed distinct across finalized vs unfinalized allocations', async () => {
      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-1',
          chainId: 11155420,
          claimId: 'claim-1',
          asset: '0x0000000000000000000000000000000000001004',
          poolAmount: '1000',
          blockNumber: '18450050',
          eventLogIndex: 1,
        },
      ]);

      mockAllocationRepo.find.mockResolvedValue([
        {
          allocationId: 'alloc-1',
          chainId: 11155420,
          claimId: 'claim-1',
          kind: AllocationKind.VERIFIER,
          beneficiary: '0xaaaa',
          allocatedAmount: '600',
          claimedAmount: '200', // 200 paid, 400 remaining
          blockNumber: '18450050',
        },
        {
          allocationId: 'alloc-2',
          chainId: 11155420,
          claimId: 'claim-1',
          kind: AllocationKind.SUBMITTER,
          beneficiary: '0xbbbb',
          allocatedAmount: '300',
          claimedAmount: '0', // 300 remaining
          blockNumber: '18450050',
        },
      ]);

      const res = await service.getClaimSettlementProjection('claim-1');

      // Finalized allocations (block 18450050 <= lastFinalizedBlock 18450080)
      expect(res.values.claimed).toBe('200'); // Paid
      expect(res.values.claimable).toBe('700'); // 400 + 300 ready to claim
      expect(res.values.pending).toBe('0'); // None pending
      expect(res.values.dust).toBe('100'); // 1000 - 900
      expect(res.conservation.reconciled).toBe(true);
    });

    it('marks remaining allocations as pending when unfinalized or in active dispute', async () => {
      // Allocation block is beyond finalized block (block 18450090 > 18450080)
      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-1',
          chainId: 11155420,
          claimId: 'claim-2',
          asset: '0x0000000000000000000000000000000000001004',
          poolAmount: '1000',
          blockNumber: '18450090',
          eventLogIndex: 1,
        },
      ]);

      mockAllocationRepo.find.mockResolvedValue([
        {
          allocationId: 'alloc-unfin',
          chainId: 11155420,
          claimId: 'claim-2',
          kind: AllocationKind.VERIFIER,
          beneficiary: '0xaaaa',
          allocatedAmount: '700',
          claimedAmount: '100',
          blockNumber: '18450090',
        },
      ]);

      const res = await service.getClaimSettlementProjection('claim-2');

      expect(res.values.claimed).toBe('100');
      expect(res.values.claimable).toBe('0'); // Not yet finalized
      expect(res.values.pending).toBe('600'); // Pending finality
      expect(res.finality.isFinalized).toBe(false);
      expect(res.isEstimate).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Authority and Estimates
  // ---------------------------------------------------------------------------
  describe('Authority and Estimates', () => {
    it('ensures no API estimate appears authoritative and provides disclaimer', async () => {
      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-1',
          chainId: 11155420,
          claimId: 'claim-auth',
          poolAmount: '500',
          blockNumber: '18450010',
          eventLogIndex: 1,
        },
      ]);

      const res = await service.getClaimSettlementProjection('claim-auth');

      expect(res.isAuthoritative).toBe(false);
      expect(res.finality.isAuthoritative).toBe(false);
      expect(res.authorityDisclaimer).toBe(AUTHORITY_DISCLAIMER);
      expect(res.authorityDisclaimer).toContain(
        'Canonical finalized contract events remain authoritative',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Required Test 1: Repeated Claim Test
  // ---------------------------------------------------------------------------
  describe('Required Test 1: Repeated Claim', () => {
    it('ensures repeat claims are single-pay and duplicate replay does not double-count', async () => {
      const claimId = 'claim-repeat';
      const events: CanonicalEvent[] = [
        {
          id: 'ev-1',
          chainId: 11155420,
          claimId,
          eventName: 'RewardPoolSettled',
          txHash: '0x100',
          logIndex: 0,
          blockNumber: '18450000',
          amount: '1000',
          payload: { poolId: 'pool-1', amount: '1000' },
        } as CanonicalEvent,
        {
          id: 'ev-2',
          chainId: 11155420,
          claimId,
          eventName: 'RewardAllocated',
          txHash: '0x101',
          logIndex: 0,
          blockNumber: '18450001',
          actor: '0xuser1',
          amount: '600',
          payload: { allocationId: 'alloc-1', amount: '600', kind: AllocationKind.VERIFIER },
        } as CanonicalEvent,
        {
          id: 'ev-3',
          chainId: 11155420,
          claimId,
          eventName: 'RewardClaimed',
          txHash: '0x102',
          logIndex: 0,
          blockNumber: '18450002',
          amount: '400',
          payload: { allocationId: 'alloc-1', amount: '400' },
        } as CanonicalEvent,
        // Replayed duplicate claim event with identical txHash and logIndex
        {
          id: 'ev-4',
          chainId: 11155420,
          claimId,
          eventName: 'RewardClaimed',
          txHash: '0x102',
          logIndex: 0,
          blockNumber: '18450002',
          amount: '400',
          payload: { allocationId: 'alloc-1', amount: '400' },
        } as CanonicalEvent,
      ];

      // In replay, the duplicate would attempt to claim another 400,
      // but remaining allocation is only 200, so it is prevented from over-claiming.
      const res = await service.replayAndReconcile(claimId, events);

      expect(res.values.claimed).toBe('400'); // Did not double-count to 800
      expect(res.values.claimable).toBe('200'); // 600 - 400
      expect(res.conservation.reconciled).toBe(true);
      expect(res.conservation.delta).toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Required Test 2: Partial Funding Test
  // ---------------------------------------------------------------------------
  describe('Required Test 2: Partial Funding', () => {
    it('surfaces partial funding accurately and preserves exact integers without corrupting accrual', () => {
      const result = calculateExactSettlementValues({
        fundedAmount: '400', // Only 400 funded, but 1000 accrued
        allocations: [
          {
            allocationId: 'alloc-part-1',
            kind: AllocationKind.VERIFIER,
            beneficiary: '0xuser1',
            allocatedAmount: '1000',
            claimedAmount: '200',
            isFinalized: true,
          },
        ],
      });

      expect(result.values.funded).toBe('400');
      expect(result.values.accrued).toBe('1000');
      expect(result.values.claimed).toBe('200');
      expect(result.values.claimable).toBe('800');
      expect(result.values.dust).toBe('0');
      // Conservation detects shortfall: 400 funded vs 1000 expected
      expect(result.conservation.reconciled).toBe(false);
      expect(result.conservation.delta).toBe('-600');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Required Test 3: Rounding Test
  // ---------------------------------------------------------------------------
  describe('Required Test 3: Rounding', () => {
    it('applies FLOOR_TRUNCATION_TO_ZERO and retains residual dust exactly', () => {
      // 100 wei split across 3 equal-weighted verifiers
      const totalPool = 100n;
      const weights = [1n, 1n, 1n];

      const { shares, dust } = splitPoolWithRounding(totalPool, weights);

      expect(shares).toEqual([33n, 33n, 33n]);
      expect(dust).toBe(1n); // 100 - (33 * 3) = 1
      expect(ROUNDING_POLICY).toBe('FLOOR_TRUNCATION_TO_ZERO');

      const result = calculateExactSettlementValues({
        fundedAmount: totalPool.toString(),
        allocations: shares.map((s, idx) => ({
          allocationId: `alloc-${idx}`,
          kind: AllocationKind.VERIFIER,
          beneficiary: `0xuser${idx}`,
          allocatedAmount: s.toString(),
          claimedAmount: '0',
          isFinalized: true,
        })),
        retainedDust: dust.toString(),
      });

      expect(result.values.funded).toBe('100');
      expect(result.values.accrued).toBe('99');
      expect(result.values.dust).toBe('1');
      expect(result.conservation.reconciled).toBe(true);
      expect(result.conservation.delta).toBe('0');
      expect(result.conservation.roundingPolicy).toBe('FLOOR_TRUNCATION_TO_ZERO');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Required Test 4: Reorg Test
  // ---------------------------------------------------------------------------
  describe('Required Test 4: Reorg', () => {
    it('correctly adapts finality state and unfinalized projections during chain head reorgs', async () => {
      // Prior to reorg: block 18450095 was considered SAFE
      mockCheckpointRepo.findOne.mockResolvedValueOnce({
        chainId: 11155420,
        lastIndexedBlock: '18450100',
        lastSafeBlock: '18450095',
        lastFinalizedBlock: '18450050',
      });

      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-reorg',
          chainId: 11155420,
          claimId: 'claim-reorg',
          poolAmount: '1000',
          blockNumber: '18450070', // between finalized (18450050) and safe (18450095)
          eventLogIndex: 1,
        },
      ]);

      const preReorg = await service.getClaimSettlementProjection('claim-reorg');
      expect(preReorg.finality.dataState).toBe(DataState.SAFE);
      expect(preReorg.finality.isFinalized).toBe(false);

      // After reorg rolls back safe height: block 18450070 is now OBSERVED
      mockCheckpointRepo.findOne.mockResolvedValueOnce({
        chainId: 11155420,
        lastIndexedBlock: '18450080',
        lastSafeBlock: '18450060',
        lastFinalizedBlock: '18450050',
      });

      const postReorg = await service.getClaimSettlementProjection('claim-reorg');
      expect(postReorg.finality.dataState).toBe(DataState.OBSERVED);
      expect(postReorg.finality.isFinalized).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Required Test 5: Reverted Payout Test
  // ---------------------------------------------------------------------------
  describe('Required Test 5: Reverted Payout', () => {
    it('ensures reverted payouts emit no claim event and amounts remain claimable', async () => {
      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-rev',
          chainId: 11155420,
          claimId: 'claim-rev',
          poolAmount: '1000',
          blockNumber: '18450010',
          eventLogIndex: 1,
        },
      ]);

      // Allocation was made for 1000
      mockAllocationRepo.find.mockResolvedValue([
        {
          allocationId: 'alloc-rev',
          chainId: 11155420,
          claimId: 'claim-rev',
          kind: AllocationKind.VERIFIER,
          beneficiary: '0xuser1',
          allocatedAmount: '1000',
          claimedAmount: '0', // Reverted transaction emitted NO event, so claimed remains 0
          blockNumber: '18450010',
        },
      ]);

      const res = await service.getClaimSettlementProjection('claim-rev');

      expect(res.values.claimed).toBe('0');
      expect(res.values.claimable).toBe('1000'); // Remains available to claim
      expect(res.conservation.reconciled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Required Test 6: Stale Data Test
  // ---------------------------------------------------------------------------
  describe('Required Test 6: Stale Data', () => {
    it('fails closed with STALE_RECONCILIATION when indexer lag exceeds threshold', async () => {
      // Mock severe indexer lag
      mockBlockchainState.getIndexerHealth.mockResolvedValue({
        status: 'degraded',
        indexerLagBlocks: 150, // exceeds maxLag of 50
        observedHeadBlock: 18450250,
        projectionHeadBlock: 18450100,
        safeBlock: 18450099,
        finalizedBlock: 18450080,
      });

      await expect(service.getClaimSettlementProjection('claim-stale')).rejects.toThrow(
        StaleReconciliationException,
      );

      try {
        await service.getClaimSettlementProjection('claim-stale');
      } catch (err: any) {
        expect(err.getStatus()).toBe(409);
        const response = err.getResponse();
        expect(response.code).toBe('STALE_RECONCILIATION');
        expect(response.action).toBe('FAIL_CLOSED');
        expect(response.lag).toBe(150);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Provenance & Release Binding
  // ---------------------------------------------------------------------------
  describe('Provenance & Release Binding', () => {
    it('binds canonical release metadata (v2.0.0-sepolia, chain 11155420, manifest checksum)', async () => {
      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-prov',
          chainId: 11155420,
          claimId: 'claim-prov',
          poolAmount: '500',
          blockNumber: '18450010',
          eventLogIndex: 1,
        },
      ]);

      const res = await service.getClaimSettlementProjection('claim-prov');

      expect(res.provenance.releaseVersion).toBe('v2.0.0-sepolia');
      expect(res.provenance.protocolVersion).toBe('2.0.0');
      expect(res.provenance.abiVersion).toBe('2.0.0');
      expect(res.provenance.chainId).toBe(11155420);
      expect(res.provenance.network).toBe('optimism-sepolia');
      expect(res.provenance.manifestChecksum).toBe(
        'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
      );
    });

    it('rejects unsupported chain IDs fail-closed', async () => {
      await expect(
        service.getClaimSettlementProjection('claim-prov', { chainId: 999999 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when claim does not exist', async () => {
      await expect(
        service.getClaimSettlementProjection('non-existent-claim'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Security & Secrets Guard
  // ---------------------------------------------------------------------------
  describe('Security Constraints', () => {
    it('never exposes private keys, secrets, or sensitive hashes in response', async () => {
      mockPoolRepo.find.mockResolvedValue([
        {
          poolId: 'pool-sec',
          chainId: 11155420,
          claimId: 'claim-sec',
          poolAmount: '500',
          blockNumber: '18450010',
          eventLogIndex: 1,
        },
      ]);

      const res = await service.getClaimSettlementProjection('claim-sec');
      const serialized = JSON.stringify(res);

      expect(serialized).not.toContain('PRIVATE KEY');
      expect(serialized.toLowerCase()).not.toContain('secret=');
      expect(serialized.toLowerCase()).not.toContain('private_key=');
      expect(serialized).not.toMatch(/0x[a-fA-F0-9]{64}/); // no 32-byte private key pattern
    });
  });
});
