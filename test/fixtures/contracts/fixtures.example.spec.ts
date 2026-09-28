import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PrismaModule } from '../../../src/prisma/prisma.module';
import {
  createMockStake,
  createMockStakes,
  createMockStakeEvent,
  createMockStakingTransactionReceipt,
  createMockStakingState,
} from './staking.fixture';
import {
  createMockReward,
  createMockRewards,
  createMockRewardDistribution,
  createMockRewardClaim,
  createMockRewardsTransactionReceipt,
  createMockRewardsState,
} from './rewards.fixture';
import {
  createMockDispute,
  createMockDisputes,
  createMockVote,
  createMockDisputeTransactionReceipt,
  createMockDisputeState,
  DisputeOutcome,
  VoteType,
} from './dispute.fixture';
import { StakingEventType } from '../../../src/staking/types/staking-event.type';
import {
  CONTRACT_ADDRESSES,
  createTestWallet,
  createMockBlock,
  createMockTransactionReceipt,
} from './blockchain.fixture';
import {
  clearDatabase,
  seedTestData,
  mockConsole,
  restoreConsole,
  waitFor,
  randomHex,
  randomAddress,
} from '../../utils/test-helpers';

/**
 * Example Test File Demonstrating Contract Fixtures Usage
 * Shows how to use the test fixtures in real test scenarios
 */

describe('Contract Fixtures Example', () => {
  let prisma: PrismaService;
  let consoleMocks: ReturnType<typeof mockConsole>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    prisma = module.get<PrismaService>(PrismaService);
    consoleMocks = mockConsole();
  });

  afterAll(async () => {
    restoreConsole(consoleMocks);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await clearDatabase(prisma);
  });

  describe('Staking Fixtures', () => {
    it('should create mock stake with default values', () => {
      const stake = createMockStake();
      
      expect(stake).toBeDefined();
      expect((stake as any).userId).toBeDefined();
      expect(stake.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(stake.amount).toBe('1000000000000000000');
      expect((stake as any).isActive).toBe(true);
    });

    it('should create mock stake with custom values', () => {
      const customStake = createMockStake({
        userId: 'user_123',
        amount: '2000000000000000000',
        isActive: false,
      });
      
      expect((customStake as any).userId).toBe('user_123');
      expect(customStake.amount).toBe('2000000000000000000');
      expect((customStake as any).isActive).toBe(false);
    });

    it('should create multiple mock stakes', () => {
      const stakes = createMockStakes(10, 'user_123');
      
      expect(stakes).toHaveLength(10);
      expect(stakes.every(stake => (stake as any).userId === 'user_123')).toBe(true);
      expect(stakes.every(stake => stake.amount)).toBeDefined();
    });

    it('should create mock stake event', () => {
      const stake = createMockStake();
      const event = createMockStakeEvent(stake, 'STAKED' as unknown as StakingEventType);
      
      expect((event as any).stakeId).toBe((stake as any).id);
      expect((event as any).eventType).toBe('STAKED');
      expect(event.amount).toBe('1000000000000000000');
      expect((event as any).transactionHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should create mock staking transaction receipt', () => {
      const wallet = createTestWallet();
      const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const receipt = createMockStakingTransactionReceipt(
        'STAKED',
        wallet.address,
        '1000000000000000000',
        txHash,
        12345
      );
      
      expect(receipt.transactionHash).toBe(txHash);
      expect(receipt.blockNumber).toBe(12345);
      expect(receipt.status).toBe(1);
      expect(receipt.logs).toHaveLength(1);
      expect(receipt.logs[0].address).toBe(CONTRACT_ADDRESSES.STAKING);
    });

    it('should create mock staking state', () => {
      const state = createMockStakingState({
        totalStaked: '2000000000000000000000',
        rewardRate: '2000000000000000',
      });
      
      expect(state.totalStaked).toBe('2000000000000000000000');
      expect(state.rewardRate).toBe('2000000000000000');
      expect(state.userStakes.size).toBeGreaterThan(0);
    });
  });

  describe('Rewards Fixtures', () => {
    it('should create mock reward with default values', () => {
      const reward = createMockReward();
      
      expect(reward).toBeDefined();
      expect((reward as any).title).toBe('Test Reward Distribution');
      expect((reward as any).totalAmount).toBe('100000000000000000000');
      expect((reward as any).isActive).toBe(true);
      expect((reward as any).expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should create mock reward with custom values', () => {
      const customReward = createMockReward({
        title: 'Custom Reward',
        totalAmount: '500000000000000000000',
        isActive: false,
      });
      
      expect((customReward as any).title).toBe('Custom Reward');
      expect((customReward as any).totalAmount).toBe('500000000000000000000');
      expect((customReward as any).isActive).toBe(false);
    });

    it('should create multiple mock rewards', () => {
      const rewards = createMockRewards(5);
      
      expect(rewards).toHaveLength(5);
      expect(rewards.map(r => (r as any).title)).toEqual([
        'Test Reward 1',
        'Test Reward 2',
        'Test Reward 3',
        'Test Reward 4',
        'Test Reward 5',
      ]);
    });

    it('should create mock reward distribution', () => {
      const reward = createMockReward();
      const distribution = createMockRewardDistribution(reward);
      
      expect((distribution as any).rewardId).toBe((reward as any).id);
      expect((distribution as any).amount).toBe('1000000000000000000');
      expect((distribution as any).claimed).toBe(false);
    });

    it('should create mock reward claim', () => {
      const reward = createMockReward();
      const distribution = createMockRewardDistribution(reward);
      const claim = createMockRewardClaim(distribution, 'user_123');
      
      expect((claim as any).distributionId).toBe((distribution as any).id);
      expect((claim as any).userId).toBe('user_123');
      expect((claim as any).claimedAmount).toBe((distribution as any).amount);
    });

    it('should create mock rewards transaction receipt', () => {
      const txHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const receipt = createMockRewardsTransactionReceipt(
        'RewardClaimed',
        {
          recipientAddress: createTestWallet().address,
          distributionId: 1,
          amount: '1000000000000000000',
        },
        txHash,
        54321
      );
      
      expect(receipt.transactionHash).toBe(txHash);
      expect(receipt.blockNumber).toBe(54321);
      expect(receipt.logs).toHaveLength(1);
    });

    it('should create mock rewards state', () => {
      const state = createMockRewardsState({
        totalRewards: '5000000000000000000000',
        rewardCount: 25,
      });
      
      expect(state.totalRewards).toBe('5000000000000000000000');
      expect(state.rewardCount).toBe(25);
      expect(state.distributionMap.size).toBeGreaterThan(0);
    });
  });

  describe('Dispute Fixtures', () => {
    it('should create mock dispute with default values', () => {
      const dispute = createMockDispute();
      
      expect(dispute).toBeDefined();
      expect(dispute.claimId).toBeDefined();
      expect((dispute as any).creatorAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect((dispute as any).evidenceCID).toMatch(/^Qm[a-zA-Z0-9]{44}$/);
      expect(dispute.outcome).toBe(DisputeOutcome.PENDING);
    });

    it('should create mock dispute with custom values', () => {
      const customDispute = createMockDispute({
        claimId: 'claim_999',
        outcome: DisputeOutcome.APPROVED,
        description: 'Custom dispute description',
      });
      
      expect(customDispute.claimId).toBe('claim_999');
      expect(customDispute.outcome).toBe(DisputeOutcome.APPROVED);
      expect((customDispute as any).description).toBe('Custom dispute description');
    });

    it('should create multiple mock disputes', () => {
      const disputes = createMockDisputes(4);
      
      expect(disputes).toHaveLength(4);
      expect(disputes.map(d => d.claimId)).toEqual([
        'claim_1',
        'claim_2',
        'claim_3',
        'claim_4',
      ]);
    });

    it('should create mock vote', () => {
      const dispute = createMockDispute();
      const vote = createMockVote(dispute, {
        vote: VoteType.FOR,
        stakeAmount: '2000000000000000000',
      });
      
      expect(vote.disputeId).toBe(dispute.id);
      expect(vote.vote).toBe(VoteType.FOR);
      expect(vote.stakeAmount).toBe('2000000000000000000');
    });

    it('should create mock dispute transaction receipt', () => {
      const txHash = '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba';
      const receipt = createMockDisputeTransactionReceipt(
        'DisputeResolved',
        {
          disputeId: 1,
          outcome: DisputeOutcome.REJECTED,
          totalStake: '5000000000000000000',
        },
        txHash,
        98765
      );
      
      expect(receipt.transactionHash).toBe(txHash);
      expect(receipt.blockNumber).toBe(98765);
      expect(receipt.logs).toHaveLength(1);
    });

    it('should create mock dispute state', () => {
      const state = createMockDisputeState({
        totalDisputes: 30,
        activeDisputes: 15,
      });
      
      expect(state.totalDisputes).toBe(30);
      expect(state.activeDisputes).toBe(15);
      expect(state.disputeMap.size).toBeGreaterThan(0);
    });
  });

  describe('Blockchain Fixtures', () => {
    it('should create test wallet with deterministic address', () => {
      const wallet1 = createTestWallet('test1');
      const wallet2 = createTestWallet('test1'); // Same seed
      const wallet3 = createTestWallet('test2'); // Different seed
      
      expect(wallet1.address).toBe(wallet2.address); // Deterministic
      expect(wallet1.address).not.toBe(wallet3.address); // Different seed = different address
    });

    it('should get contract addresses', () => {
      expect(CONTRACT_ADDRESSES.STAKING).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
      expect(CONTRACT_ADDRESSES.REWARDS).toBe('0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512');
      expect(CONTRACT_ADDRESSES.DISPUTE).toBe('0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0');
    });

    it('should create mock block', () => {
      const block = createMockBlock(100);
      
      expect(block.number).toBe(100);
      expect(block.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(block.timestamp).toBeGreaterThan(0);
      expect(block.transactions).toHaveLength(1);
    });

    it('should create mock transaction receipt', () => {
      const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
      const receipt = createMockTransactionReceipt(txHash, 200);
      
      expect(receipt.transactionHash).toBe(txHash);
      expect(receipt.blockNumber).toBe(200);
      expect(receipt.status).toBe(1);
      expect(receipt.gasUsed).toBe(BigInt(21000));
    });
  });

  describe('Database Integration', () => {
    it('should seed database with test data', async () => {
      const testData = await seedTestData(prisma, {
        stakes: 3,
        rewards: 2,
        disputes: 1,
      });
      
      expect(testData.stakes).toHaveLength(3);
      expect(testData.rewards).toHaveLength(2);
      expect(testData.disputes).toHaveLength(1);
      
      // Verify data was actually inserted
      const stakeCount = await (prisma as any).stake.count();
      const rewardCount = await (prisma as any).reward.count();
      const disputeCount = await (prisma as any).dispute.count();
      
      expect(stakeCount).toBe(3);
      expect(rewardCount).toBe(2);
      expect(disputeCount).toBe(1);
    }, 10000);

    it('should clear database', async () => {
      // First seed some data
      await seedTestData(prisma, { stakes: 2, rewards: 1 });
      
      // Verify data exists
      expect(await (prisma as any).stake.count()).toBeGreaterThan(0);
      expect(await (prisma as any).reward.count()).toBeGreaterThan(0);
      
      // Clear database
      await clearDatabase(prisma);
      
      // Verify data is cleared
      expect(await (prisma as any).stake.count()).toBe(0);
      expect(await (prisma as any).reward.count()).toBe(0);
      expect(await (prisma as any).dispute.count()).toBe(0);
    }, 10000);
  });

  describe('Test Utilities', () => {
    it('should wait for specified time', async () => {
      const start = Date.now();
      await waitFor(100);
      const end = Date.now();
      
      expect(end - start).toBeGreaterThanOrEqual(95); // Allow small margin
      expect(end - start).toBeLessThanOrEqual(105);
    });

    it('should generate random hex string', () => {
      const hex1 = randomHex();
      const hex2 = randomHex(16);
      
      expect(hex1).toMatch(/^0x[a-fA-F0-9]{64}$/); // 32 bytes = 64 hex chars
      expect(hex2).toMatch(/^0x[a-fA-F0-9]{32}$/); // 16 bytes = 32 hex chars
    });

    it('should generate random address', () => {
      const address = randomAddress();
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });
});