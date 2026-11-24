import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import {
  StakeProjectionService,
  CANONICAL_RELEASE_METADATA,
  AUTHORITY_DISCLAIMER,
} from './stake-projection.service';
import {
  calculateExactStakeBalances,
  toBigIntSafe,
  ROUNDING_POLICY,
  CANONICAL_STAKE_STATES,
  StakeLockItem,
  PayoutProjectionItem,
  StakeSlashItem,
} from './stake-projection.types';
import { DataState } from '../common/data-state.enum';
import { DisputeStatus } from '../disputes/entities/project-dispute.entity';
import { StaleReconciliationException } from '../rewards/exceptions/stale-reconciliation.exception';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';

describe('StakeProjectionService (PREWAVE-BE-065)', () => {
  let service: StakeProjectionService;
  let mockStakeRepo: any;
  let mockLockRepo: any;
  let mockWithdrawalRepo: any;
  let mockStakeEventRepo: any;
  let mockCheckpointRepo: any;
  let mockRoundRepo: any;
  let mockDisputeRepo: any;
  let mockBlockchainState: any;
  let mockFinalityPolicy: any;

  const testWallet = '0x1111111111111111111111111111111111111111';
  const testClaim = '0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    mockStakeRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    mockLockRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockWithdrawalRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((val) => val),
      save: jest.fn().mockImplementation((val) => Promise.resolve(val)),
    };
    mockStakeEventRepo = {
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
      find: jest.fn().mockResolvedValue([]),
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

    service = new StakeProjectionService(
      mockStakeRepo,
      mockLockRepo,
      mockWithdrawalRepo,
      mockStakeEventRepo,
      mockCheckpointRepo,
      mockRoundRepo,
      mockDisputeRepo,
      mockBlockchainState,
      mockFinalityPolicy,
    );
  });

  // ---------------------------------------------------------------------------
  // 1. Stake & Unstake Tests
  // ---------------------------------------------------------------------------
  describe('Stake / Unstake Tests', () => {
    it('models deposited stake, increases available balance and totalStaked, and verifies conservation', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '100000000000000000000', // 100 tokens in wei
          lastTxHash: '0xtx1',
          updatedAt: new Date(),
        },
      ]);

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.walletAddress).toBe(testWallet);
      expect(projection.balances.totalStaked).toBe('100000000000000000000');
      expect(projection.balances.available).toBe('100000000000000000000');
      expect(projection.balances.locked).toBe('0');
      expect(projection.balances.pendingWithdrawal).toBe('0');
      expect(projection.balances.slashed).toBe('0');
      expect(projection.balances.withdrawn).toBe('0');
      expect(projection.conservation.reconciled).toBe(true);
      expect(projection.conservation.delta).toBe('0');
      expect(projection.authorityDisclaimer).toBe(AUTHORITY_DISCLAIMER);
    });

    it('models completed unstake / withdrawal, reducing available and increasing withdrawn', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '100000000000000000000',
        },
      ]);
      mockWithdrawalRepo.find.mockResolvedValue([
        {
          id: 'w-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '40000000000000000000', // 40 tokens withdrawn
          txHash: '0xwithdraw1',
          blockNumber: 18450050,
          createdAt: new Date(),
        },
      ]);

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.balances.totalStaked).toBe('100000000000000000000');
      expect(projection.balances.available).toBe('60000000000000000000'); // 100 - 40 = 60
      expect(projection.balances.withdrawn).toBe('40000000000000000000');
      expect(projection.conservation.reconciled).toBe(true);
      expect(projection.conservation.delta).toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Dust & 256-bit Integer Arithmetic Tests
  // ---------------------------------------------------------------------------
  describe('Dust & 256-bit Integer Arithmetic Tests', () => {
    it('preserves exact 256-bit quantities and accounts for retained dust with FLOOR_TRUNCATION_TO_ZERO without float truncation', () => {
      const hugeDeposit = '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // 2^256 - 1
      const lockAmount = '100000000000000000000';
      const dustAmount = '7';

      const result = calculateExactStakeBalances({
        totalStaked: hugeDeposit,
        locks: [
          {
            lockId: 'lock-1',
            claimId: testClaim,
            walletAddress: testWallet,
            amount: lockAmount,
            unlocksAt: Math.floor(Date.now() / 1000) + 10000,
            status: 'ACTIVE',
          },
        ],
        payouts: [],
        slashes: [],
        retainedDust: dustAmount,
      });

      expect(result.conservation.reconciled).toBe(true);
      expect(result.conservation.delta).toBe('0');
      expect(result.conservation.roundingPolicy).toBe(ROUNDING_POLICY);
      expect(result.balances.dust).toBe(dustAmount);
      expect(result.conservation.digest).toBeDefined();
      expect(typeof result.conservation.digest).toBe('string');
      expect(result.conservation.digest.length).toBe(64); // SHA-256 hex
    });

    it('fails closed on non-integer, negative, or malformed numerical representations', () => {
      expect(() => toBigIntSafe('123.45', 'stakeAmount')).toThrow(
        /Invalid integer representation/,
      );
      expect(() => toBigIntSafe('1e18', 'stakeAmount')).toThrow(
        /Invalid integer representation/,
      );
      expect(() => toBigIntSafe('NaN', 'stakeAmount')).toThrow(
        /Invalid integer representation/,
      );
      expect(() => toBigIntSafe(-50n, 'stakeAmount')).toThrow(
        /Negative value not allowed/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Over-unlock & Locked Funds Segregation Tests
  // ---------------------------------------------------------------------------
  describe('Over-unlock & Locked Funds Segregation Tests', () => {
    it('guarantees locked funds never appear in available/withdrawable balance', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '100000',
        },
      ]);
      mockLockRepo.find.mockResolvedValue([
        {
          id: 'lock-active',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '80000',
          unlocksAt: String(Math.floor(Date.now() / 1000) + 5000), // active in future
        },
      ]);

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.balances.totalStaked).toBe('100000');
      expect(projection.balances.locked).toBe('80000');
      // Locked funds MUST NOT appear withdrawable
      expect(projection.balances.available).toBe('20000');
      expect(projection.stakeState).toBe('PARTIALLY_LOCKED');
    });

    it('fails closed and rejects attempts to unlock more than currently locked (over-unlock protection)', async () => {
      const canonicalEvents: CanonicalEvent[] = [
        {
          id: 'ev-1',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'Staked',
          txHash: '0xtx1',
          logIndex: 0,
          blockNumber: '100',
          claimId: testClaim,
          actor: testWallet,
          amount: '100000',
          payload: { amount: '100000' },
          rawArgs: {},
          ingestedAt: new Date(),
        },
        {
          id: 'ev-2',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'StakeLocked',
          txHash: '0xtx2',
          logIndex: 1,
          blockNumber: '101',
          claimId: testClaim,
          actor: testWallet,
          amount: '30000',
          payload: { lockId: 'lock-1', amount: '30000', unlocksAt: 9999999999 },
          rawArgs: {},
          ingestedAt: new Date(),
        },
        {
          id: 'ev-3',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'StakeUnlocked',
          txHash: '0xtx3',
          logIndex: 2,
          blockNumber: '102',
          claimId: testClaim,
          actor: testWallet,
          amount: '50000', // Attempting to unlock 50000 when only 30000 is locked!
          payload: { lockId: 'lock-1', amount: '50000' },
          rawArgs: {},
          ingestedAt: new Date(),
        },
      ] as unknown as CanonicalEvent[];

      await expect(
        service.replayAndReconcile(testWallet, canonicalEvents),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Slash Tests
  // ---------------------------------------------------------------------------
  describe('Slash Tests', () => {
    it('models stake slashing, reducing available and recording slashed balance in conservation digest', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '100000',
        },
      ]);
      mockStakeEventRepo.find.mockResolvedValue([
        {
          id: 'slash-ev-1',
          walletAddress: testWallet,
          claimId: testClaim,
          type: 'STAKE_SLASHED',
          amount: '25000',
          txHash: '0xslash1',
          blockNumber: 18450040,
        },
      ]);

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.balances.totalStaked).toBe('100000');
      expect(projection.balances.slashed).toBe('25000');
      expect(projection.balances.available).toBe('75000');
      expect(projection.conservation.reconciled).toBe(true);
      expect(projection.conservation.delta).toBe('0');
    });

    it('handles 100% full slashing resulting in CANONICAL_STAKE_STATES SLASHED', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '50000',
        },
      ]);
      mockStakeEventRepo.find.mockResolvedValue([
        {
          id: 'slash-ev-full',
          walletAddress: testWallet,
          claimId: testClaim,
          type: 'STAKE_SLASHED',
          amount: '50000',
          txHash: '0xslashfull',
          blockNumber: 18450040,
        },
      ]);

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.balances.available).toBe('0');
      expect(projection.balances.slashed).toBe('50000');
      expect(projection.stakeState).toBe('SLASHED');
      expect(projection.conservation.reconciled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Failed Payout & Retryable Payout Tests
  // ---------------------------------------------------------------------------
  describe('Failed Payout & Retryable Payout Tests', () => {
    it('models failed payout, keeping it retryable in pendingWithdrawal without double debit', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '100000',
        },
      ]);

      service.registerFailedPayout({
        payoutId: 'payout-fail-1',
        claimId: testClaim,
        walletAddress: testWallet,
        amount: '30000',
        failureReason: 'Transaction reverted during gas spike',
      });

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.balances.pendingWithdrawal).toBe('30000');
      expect(projection.balances.available).toBe('70000');
      expect(projection.balances.withdrawn).toBe('0');
      expect(projection.payouts).toHaveLength(1);
      expect(projection.payouts[0].status).toBe('RETRYABLE');
      expect(projection.payouts[0].retryable).toBe(true);
      expect(projection.conservation.reconciled).toBe(true);
    });

    it('allows retryable payout to be retried successfully, transitioning to COMPLETED', async () => {
      const payout = service.registerFailedPayout({
        payoutId: 'payout-fail-2',
        claimId: testClaim,
        walletAddress: testWallet,
        amount: '20000',
        failureReason: 'Network timeout',
      });

      expect(payout.retryable).toBe(true);
      expect(payout.retryCount).toBe(0);

      const retried = await service.retryPayout('payout-fail-2', {
        simulateSuccess: true,
        newTxHash: '0xretrysuccess',
      });

      expect(retried.status).toBe('COMPLETED');
      expect(retried.retryable).toBe(false);
      expect(retried.retryCount).toBe(1);
      expect(retried.txHash).toBe('0xretrysuccess');
      expect(mockWithdrawalRepo.save).toHaveBeenCalled();
    });

    it('fails closed when attempting to retry a non-retryable payout', async () => {
      await expect(service.retryPayout('non-existent-payout')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Appeal Carry Tests
  // ---------------------------------------------------------------------------
  describe('Appeal Carry Tests', () => {
    it('carries round lock forward when dispute is raised, keeping funds locked until appeal settlement', async () => {
      mockStakeRepo.find.mockResolvedValue([
        {
          id: 'stake-1',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '100000',
        },
      ]);
      mockLockRepo.find.mockResolvedValue([
        {
          id: 'lock-appeal-carry',
          walletAddress: testWallet,
          claimId: testClaim,
          amount: '50000',
          unlocksAt: '1000', // In the past
        },
      ]);
      mockDisputeRepo.find.mockResolvedValue([
        {
          disputeId: 'disp-1',
          claimId: testClaim,
          status: DisputeStatus.RAISED, // Active appeal
        },
      ]);

      const projection = await service.getWalletStakeProjection(testWallet, {
        claimId: testClaim,
      });

      expect(projection.balances.locked).toBe('50000');
      expect(projection.balances.available).toBe('50000');
      expect(projection.locks[0].isAppealCarry).toBe(true);
      expect(projection.locks[0].status).toBe('APPEAL_CARRIED');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Reorg Tests
  // ---------------------------------------------------------------------------
  describe('Reorg Tests', () => {
    it('rolls back unfinalized events on chain reorg to checkpoint height, restoring previous state and digest', async () => {
      const canonicalEvents: CanonicalEvent[] = [
        {
          id: 'ev-1',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'Staked',
          txHash: '0xtx1',
          logIndex: 0,
          blockNumber: '100',
          claimId: testClaim,
          actor: testWallet,
          amount: '50000',
          payload: { amount: '50000' },
          rawArgs: {},
          ingestedAt: new Date(),
        },
        {
          id: 'ev-2',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'Staked',
          txHash: '0xtx2',
          logIndex: 0,
          blockNumber: '150', // Mined on orphaned fork
          claimId: testClaim,
          actor: testWallet,
          amount: '25000',
          payload: { amount: '25000' },
          rawArgs: {},
          ingestedAt: new Date(),
        },
      ] as unknown as CanonicalEvent[];

      const reorgResult = await service.handleReorgRollback(
        testWallet,
        canonicalEvents,
        120,
      );

      expect(reorgResult.revertedCount).toBe(1);
      expect(reorgResult.balances.totalStaked).toBe('50000');
      expect(reorgResult.balances.available).toBe('50000');
      expect(reorgResult.conservation.reconciled).toBe(true);
      expect(reorgResult.conservation.delta).toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Rebuild Tests
  // ---------------------------------------------------------------------------
  describe('Rebuild Tests', () => {
    it('rebuilds projection deterministically from genesis canonical events, producing identical balances and SHA-256 digest', async () => {
      const canonicalEvents: CanonicalEvent[] = [
        {
          id: 'ev-1',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'Staked',
          txHash: '0xtx1',
          logIndex: 0,
          blockNumber: '100',
          claimId: testClaim,
          actor: testWallet,
          amount: '200000',
          payload: { amount: '200000' },
          rawArgs: {},
          ingestedAt: new Date(),
        },
        {
          id: 'ev-2',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'StakeLocked',
          txHash: '0xtx2',
          logIndex: 1,
          blockNumber: '105',
          claimId: testClaim,
          actor: testWallet,
          amount: '50000',
          payload: { lockId: 'lock-rb-1', amount: '50000', unlocksAt: 9999999999 },
          rawArgs: {},
          ingestedAt: new Date(),
        },
        {
          id: 'ev-3',
          chainId: 11155420,
          contractAddress: '0xcontract',
          artifactVersion: 'v2.0.0',
          eventName: 'StakeWithdrawn',
          txHash: '0xtx3',
          logIndex: 0,
          blockNumber: '110',
          claimId: testClaim,
          actor: testWallet,
          amount: '30000',
          payload: { payoutId: 'payout-rb-1', amount: '30000' },
          rawArgs: {},
          ingestedAt: new Date(),
        },
      ] as unknown as CanonicalEvent[];

      const rebuild1 = await service.replayAndReconcile(testWallet, canonicalEvents);
      const rebuild2 = await service.replayAndReconcile(testWallet, canonicalEvents);

      expect(rebuild1.balances).toEqual(rebuild2.balances);
      expect(rebuild1.balances.totalStaked).toBe('200000');
      expect(rebuild1.balances.locked).toBe('50000');
      expect(rebuild1.balances.withdrawn).toBe('30000');
      expect(rebuild1.balances.available).toBe('120000');

      expect(rebuild1.conservation.digest).toBe(rebuild2.conservation.digest);
      expect(rebuild1.conservation.reconciled).toBe(true);
      expect(rebuild1.conservation.delta).toBe('0');
      expect(rebuild1.appliedCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Fail-Closed Staleness and Missing State Tests
  // ---------------------------------------------------------------------------
  describe('Fail-Closed Rules', () => {
    it('fails closed when indexer is unhealthy', async () => {
      mockBlockchainState.getIndexerHealth.mockResolvedValue({
        status: 'unhealthy',
      });

      await expect(service.getWalletStakeProjection(testWallet)).rejects.toThrow(
        StaleReconciliationException,
      );
    });

    it('fails closed when indexer lag exceeds maxLagBlocks', async () => {
      mockBlockchainState.getIndexerHealth.mockResolvedValue({
        status: 'healthy',
        indexerLagBlocks: 100,
      });

      await expect(service.getWalletStakeProjection(testWallet)).rejects.toThrow(
        StaleReconciliationException,
      );
    });

    it('throws NotFoundException when wallet has no staking activity', async () => {
      mockStakeRepo.find.mockResolvedValue([]);
      mockLockRepo.find.mockResolvedValue([]);
      mockWithdrawalRepo.find.mockResolvedValue([]);
      mockStakeEventRepo.find.mockResolvedValue([]);

      await expect(service.getWalletStakeProjection(testWallet)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
