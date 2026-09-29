import { Stake } from '../../../src/staking/entities/stake.entity';
import { StakeEvent } from '../../../src/staking/entities/stake-event.entity';
import { StakingEventType } from '../../../src/staking/types/staking-event.type';
import { createTestWallet, getContractAddress, createMockLog, createMockTransactionReceipt } from './blockchain.fixture';

/**
 * Staking Contract Test Fixtures
 * Provides mock data for staking contract interactions and events
 */

// Mock staking contract ABI events signatures
export const STAKING_EVENT_SIGNATURES = {
  STAKED: 'Staked(address,uint256,uint256)',
  UNSTAKED: 'Unstaked(address,uint256,uint256)',
  SLASHED: 'Slashed(address,uint256,uint256)',
  REWARDS_CLAIMED: 'RewardsClaimed(address,uint256)',
} as const;

/**
 * Mock stake data
 */
export interface MockStakeData {
  id?: string;
  userId: string;
  walletAddress: string;
  amount: string;
  stakedAt: Date;
  unstakedAt?: Date;
  isActive: boolean;
  totalRewards: string;
}

/**
 * Mock stake event data
 */
export interface MockStakeEventData {
  id?: string;
  stakeId: string;
  eventType: StakingEventType;
  amount: string;
  timestamp: Date;
  transactionHash: string;
  blockNumber: number;
}

/**
 * Create mock stake entity
 */
export function createMockStake(overrides: Partial<MockStakeData> = {}): Stake {
  const defaultData: MockStakeData = {
    userId: `user_${Math.random().toString(36).substr(2, 9)}`,
    walletAddress: createTestWallet().address,
    amount: '1000000000000000000', // 1 ETH in wei
    stakedAt: new Date(),
    isActive: true,
    totalRewards: '0',
  };

  const stakeData = { ...defaultData, ...overrides };
  
  return {
    id: stakeData.id || `stake_${Math.random().toString(36).substr(2, 9)}`,
    userId: stakeData.userId,
    walletAddress: stakeData.walletAddress,
    amount: stakeData.amount,
    stakedAt: stakeData.stakedAt,
    unstakedAt: stakeData.unstakedAt,
    isActive: stakeData.isActive,
    totalRewards: stakeData.totalRewards,
    createdAt: new Date(),
    updatedAt: new Date(),
    stakeEvents: [],
  } as unknown as Stake;
}

/**
 * Create mock stake event
 */
export function createMockStakeEvent(
  stake: Stake,
  eventType: StakingEventType = ('STAKED' as unknown as StakingEventType),
  overrides: Partial<MockStakeEventData> = {}
): StakeEvent {
  const defaultData: MockStakeEventData = {
    stakeId: (stake as any).id,
    eventType,
    amount: '1000000000000000000', // 1 ETH in wei
    timestamp: new Date(),
    transactionHash: `0x${Math.random().toString(16).substr(2, 64)}`,
    blockNumber: Math.floor(Math.random() * 1000000),
  };

  const eventData = { ...defaultData, ...overrides };
  
  return {
    id: eventData.id || `event_${Math.random().toString(36).substr(2, 9)}`,
    stakeId: eventData.stakeId,
    eventType: eventData.eventType,
    amount: eventData.amount,
    timestamp: eventData.timestamp,
    transactionHash: eventData.transactionHash,
    blockNumber: eventData.blockNumber,
    createdAt: new Date(),
  } as unknown as StakeEvent;
}

/**
 * Create multiple mock stakes
 */
export function createMockStakes(count: number = 5, userId?: string): Stake[] {
  return Array.from({ length: count }, (_, i) => 
    createMockStake({
      userId: userId || `user_${Math.random().toString(36).substr(2, 9)}`,
      amount: (1 + i * 0.5).toString() + '000000000000000000', // 1, 1.5, 2, 2.5, 3 ETH
      stakedAt: new Date(Date.now() - (count - i) * 86400000), // Staked 1-5 days ago
    })
  );
}

/**
 * Create mock staking contract event log
 */
export function createMockStakingEventLog(
  eventType: StakingEventType | string,
  walletAddress: string,
  amount: string,
  totalStaked: string = '0',
  blockNumber: number = 1
) {
  const contractAddress = getContractAddress('STAKING');
  let topics: string[] = [];
  let data = '';

  switch (eventType) {
    case 'STAKED':
      topics = [
        STAKING_EVENT_SIGNATURES.STAKED,
        '0x' + walletAddress.padStart(64, '0'),
      ];
      data = '0x' + 
        BigInt(amount).toString(16).padStart(64, '0') +
        BigInt(totalStaked).toString(16).padStart(64, '0');
      break;
      
    case 'UNSTAKED':
      topics = [
        STAKING_EVENT_SIGNATURES.UNSTAKED,
        '0x' + walletAddress.padStart(64, '0'),
      ];
      data = '0x' + 
        BigInt(amount).toString(16).padStart(64, '0') +
        BigInt(totalStaked).toString(16).padStart(64, '0');
      break;
      
    case 'SLASHED':
      topics = [
        STAKING_EVENT_SIGNATURES.SLASHED,
        '0x' + walletAddress.padStart(64, '0'),
      ];
      data = '0x' + 
        BigInt(amount).toString(16).padStart(64, '0') +
        BigInt(totalStaked).toString(16).padStart(64, '0');
      break;
      
    case 'REWARDS_CLAIMED':
      topics = [
        STAKING_EVENT_SIGNATURES.REWARDS_CLAIMED,
        '0x' + walletAddress.padStart(64, '0'),
      ];
      data = '0x' + BigInt(amount).toString(16).padStart(64, '0');
      break;
  }

  return createMockLog(contractAddress, topics, data, blockNumber);
}

/**
 * Create mock staking transaction receipt with events
 */
export function createMockStakingTransactionReceipt(
  eventType: StakingEventType | string,
  walletAddress: string,
  amount: string,
  txHash: string,
  blockNumber: number = 1
) {
  const receipt = createMockTransactionReceipt(txHash, blockNumber);
  receipt.logs = [
    createMockStakingEventLog(eventType, walletAddress, amount, '1000000000000000000', blockNumber)
  ];
  return receipt;
}

/**
 * Mock staking contract state
 */
export interface MockStakingState {
  totalStaked: string;
  rewardRate: string;
  lastUpdateTime: number;
  rewardPerTokenStored: string;
  userStakes: Map<string, string>; // address -> staked amount
}

/**
 * Create mock staking contract state
 */
export function createMockStakingState(overrides: Partial<MockStakingState> = {}): MockStakingState {
  const defaultState: MockStakingState = {
    totalStaked: '1000000000000000000000', // 1000 ETH
    rewardRate: '1000000000000000', // 0.001 ETH per second
    lastUpdateTime: Math.floor(Date.now() / 1000),
    rewardPerTokenStored: '500000000000000000', // 0.5 tokens
    userStakes: new Map(),
  };

  const state = { ...defaultState, ...overrides };
  
  // Add some default user stakes if none provided
  if (state.userStakes.size === 0) {
    const wallet1 = createTestWallet('user1');
    const wallet2 = createTestWallet('user2');
    state.userStakes.set(wallet1.address, '1000000000000000000'); // 1 ETH
    state.userStakes.set(wallet2.address, '2500000000000000000'); // 2.5 ETH
  }

  return state;
}