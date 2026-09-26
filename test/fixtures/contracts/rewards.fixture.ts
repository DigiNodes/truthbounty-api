import { Reward } from '../../../src/rewards/entities/reward.entity';
import { RewardDistribution } from '../../../src/rewards/entities/reward-distribution.entity';
import { RewardClaim } from '../../../src/rewards/entities/reward-claim.entity';
import { createTestWallet, getContractAddress, createMockLog, createMockTransactionReceipt } from './blockchain.fixture';

/**
 * Rewards Contract Test Fixtures
 * Provides mock data for rewards contract interactions and events
 */

// Mock rewards contract ABI events signatures
export const REWARDS_EVENT_SIGNATURES = {
  DISTRIBUTION_CREATED: 'DistributionCreated(uint256,address,uint256)',
  REWARDS_DISTRIBUTED: 'RewardsDistributed(address,uint256)',
  REWARD_CLAIMED: 'RewardClaimed(address,uint256,uint256)',
  CLAIM_PERIOD_EXTENDED: 'ClaimPeriodExtended(uint256,uint256)',
} as const;

/**
 * Mock reward data
 */
export interface MockRewardData {
  id?: string;
  title: string;
  description: string;
  totalAmount: string;
  tokenAddress: string;
  creatorAddress: string;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;
}

/**
 * Mock reward distribution data
 */
export interface MockRewardDistributionData {
  id?: string;
  rewardId: string;
  recipientAddress: string;
  amount: string;
  claimed: boolean;
  claimedAt?: Date;
  transactionHash?: string;
}

/**
 * Mock reward claim data
 */
export interface MockRewardClaimData {
  id?: string;
  distributionId: string;
  userId: string;
  claimedAmount: string;
  claimedAt: Date;
  transactionHash: string;
  blockNumber: number;
}

/**
 * Create mock reward entity
 */
export function createMockReward(overrides: Partial<MockRewardData> = {}): Reward {
  const defaultData: MockRewardData = {
    title: 'Test Reward Distribution',
    description: 'Reward for participating in the protocol',
    totalAmount: '100000000000000000000', // 100 ETH
    tokenAddress: '0x0000000000000000000000000000000000000000', // ETH
    creatorAddress: createTestWallet('creator').address,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    isActive: true,
  };

  const rewardData = { ...defaultData, ...overrides };
  
  return {
    id: rewardData.id || `reward_${Math.random().toString(36).substr(2, 9)}`,
    title: rewardData.title,
    description: rewardData.description,
    totalAmount: rewardData.totalAmount,
    tokenAddress: rewardData.tokenAddress,
    creatorAddress: rewardData.creatorAddress,
    createdAt: rewardData.createdAt,
    expiresAt: rewardData.expiresAt,
    isActive: rewardData.isActive,
    rewardDistributions: [],
    rewardClaims: [],
  } as Reward;
}

/**
 * Create mock reward distribution
 */
export function createMockRewardDistribution(
  reward: Reward,
  overrides: Partial<MockRewardDistributionData> = {}
): RewardDistribution {
  const defaultData: MockRewardDistributionData = {
    rewardId: (reward as any).id,
    recipientAddress: createTestWallet().address,
    amount: '1000000000000000000', // 1 ETH
    claimed: false,
  };

  const distributionData = { ...defaultData, ...overrides };
  
  return {
    id: distributionData.id || `dist_${Math.random().toString(36).substr(2, 9)}`,
    rewardId: distributionData.rewardId,
    recipientAddress: distributionData.recipientAddress,
    amount: distributionData.amount,
    claimed: distributionData.claimed,
    claimedAt: distributionData.claimedAt,
    transactionHash: distributionData.transactionHash,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as RewardDistribution;
}

/**
 * Create mock reward claim
 */
export function createMockRewardClaim(
  distribution: RewardDistribution,
  userId: string,
  overrides: Partial<MockRewardClaimData> = {}
): RewardClaim {
  const defaultData: MockRewardClaimData = {
    distributionId: (distribution as any).id,
    userId,
    claimedAmount: (distribution as any).amount,
    claimedAt: new Date(),
    transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
    blockNumber: Math.floor(Math.random() * 1000000),
  };

  const claimData = { ...defaultData, ...overrides };
  
  return {
    id: claimData.id || `claim_${Math.random().toString(36).substr(2, 9)}`,
    distributionId: claimData.distributionId,
    userId: claimData.userId,
    claimedAmount: claimData.claimedAmount,
    claimedAt: claimData.claimedAt,
    transactionHash: claimData.transactionHash,
    blockNumber: claimData.blockNumber,
    createdAt: new Date(),
  } as unknown as RewardClaim;
}

/**
 * Create multiple mock rewards
 */
export function createMockRewards(count: number = 3): Reward[] {
  return Array.from({ length: count }, (_, i) => 
    createMockReward({
      title: `Test Reward ${i + 1}`,
      totalAmount: ((i + 1) * 50).toString() + '0000000000000000000', // 50, 100, 150 ETH
      createdAt: new Date(Date.now() - i * 86400000), // Created 0-2 days ago
    })
  );
}

/**
 * Create multiple reward distributions for a reward
 */
export function createMockDistributions(reward: Reward, count: number = 5): RewardDistribution[] {
  return Array.from({ length: count }, (_, i) => 
    createMockRewardDistribution(reward, {
      recipientAddress: createTestWallet(`recipient${i}`).address,
      amount: Math.floor((i + 1) * 10).toString() + '000000000000000000', // 10, 20, 30, 40, 50 ETH
      claimed: i < 3, // First 3 are claimed
    })
  );
}

/**
 * Create mock rewards contract event log
 */
export function createMockRewardsEventLog(
  eventType: string,
  params: any,
  blockNumber: number = 1
) {
  const contractAddress = getContractAddress('REWARDS');
  let topics: string[];
  let data: string;

  switch (eventType) {
    case 'DistributionCreated':
      topics = [
        REWARDS_EVENT_SIGNATURES.DISTRIBUTION_CREATED,
        '0x' + Number(params.distributionId).toString(16).padStart(64, '0'),
        '0x' + params.recipientAddress.slice(2).padStart(64, '0'),
      ];
      data = '0x' + BigInt(params.amount).toString(16).padStart(64, '0');
      break;
      
    case 'RewardsDistributed':
      topics = [
        REWARDS_EVENT_SIGNATURES.REWARDS_DISTRIBUTED,
        '0x' + params.recipientAddress.slice(2).padStart(64, '0'),
      ];
      data = '0x' + BigInt(params.amount).toString(16).padStart(64, '0');
      break;
      
    case 'RewardClaimed':
      topics = [
        REWARDS_EVENT_SIGNATURES.REWARD_CLAIMED,
        '0x' + params.recipientAddress.slice(2).padStart(64, '0'),
        '0x' + Number(params.distributionId).toString(16).padStart(64, '0'),
      ];
      data = '0x' + BigInt(params.amount).toString(16).padStart(64, '0');
      break;
      
    case 'ClaimPeriodExtended':
      topics = [
        REWARDS_EVENT_SIGNATURES.CLAIM_PERIOD_EXTENDED,
        '0x' + Number(params.rewardId).toString(16).padStart(64, '0'),
      ];
      data = '0x' + BigInt(params.newExpiry).toString(16).padStart(64, '0');
      break;
      
    default:
      throw new Error(`Unknown event type: ${eventType}`);
  }

  return createMockLog(contractAddress, topics, data, blockNumber);
}

/**
 * Create mock rewards transaction receipt with events
 */
export function createMockRewardsTransactionReceipt(
  eventType: string,
  params: any,
  txHash: string,
  blockNumber: number = 1
) {
  const receipt = createMockTransactionReceipt(txHash, blockNumber);
  receipt.logs = [
    createMockRewardsEventLog(eventType, params, blockNumber)
  ];
  return receipt;
}

/**
 * Mock rewards contract state
 */
export interface MockRewardsState {
  totalRewards: string;
  totalDistributed: string;
  totalClaimed: string;
  rewardCount: number;
  claimPeriod: number; // in seconds
  distributionMap: Map<string, RewardDistribution[]>; // rewardId -> distributions
}

/**
 * Create mock rewards contract state
 */
export function createMockRewardsState(overrides: Partial<MockRewardsState> = {}): MockRewardsState {
  const defaultState: MockRewardsState = {
    totalRewards: '10000000000000000000000', // 10000 ETH
    totalDistributed: '2500000000000000000000', // 2500 ETH
    totalClaimed: '1500000000000000000000', // 1500 ETH
    rewardCount: 10,
    claimPeriod: 30 * 24 * 60 * 60, // 30 days
    distributionMap: new Map(),
  };

  const state = { ...defaultState, ...overrides };
  
  // Add some default distributions if none provided
  if (state.distributionMap.size === 0) {
    const reward1 = createMockReward({ id: 'reward_1' });
    const reward2 = createMockReward({ id: 'reward_2' });
    
    state.distributionMap.set((reward1 as any).id, createMockDistributions(reward1, 3));
    state.distributionMap.set((reward2 as any).id, createMockDistributions(reward2, 2));
  }

  return state;
}