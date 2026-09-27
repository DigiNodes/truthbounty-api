import { Wallet, HDNodeWallet } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

/**
 * Blockchain Test Fixtures
 * Provides deterministic contract addresses and blockchain state for testing
 */

// Deterministic contract addresses for local testing
export const CONTRACT_ADDRESSES = {
  STAKING: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  REWARDS: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  DISPUTE: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  GOVERNANCE: '0xCf7Ed32C44A987815c280032D527e475B59B428F',
  TOKEN: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
} as const;

export type ContractType = keyof typeof CONTRACT_ADDRESSES;

/**
 * Generate deterministic wallet for testing
 */
export function createTestWallet(seed: string = 'test'): HDNodeWallet {
  const mnemonic = `test test test test test test test test test test test ${seed}`;
  return Wallet.fromPhrase(mnemonic);
}

/**
 * Get deterministic contract address
 */
export function getContractAddress(type: ContractType): string {
  return CONTRACT_ADDRESSES[type];
}

/**
 * Mock blockchain network configuration
 */
export const MOCK_BLOCKCHAIN_CONFIG = {
  RPC_URL: 'http://localhost:8545',
  CHAIN_ID: 31337,
  CONFIRMATIONS: 1,
  BLOCK_TIME: 1000,
  GAS_PRICE: '20000000000',
  MAX_GAS: 8000000,
} as const;

/**
 * Mock block data structure
 */
export interface MockBlock {
  number: number;
  hash: string;
  timestamp: number;
  parentHash: string;
  transactions: string[];
}

/**
 * Mock transaction receipt structure
 */
export interface MockTransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  status: number;
  gasUsed: bigint;
  logs: MockLog[];
}

/**
 * Mock log structure
 */
export interface MockLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

/**
 * Generate mock block data
 */
export function createMockBlock(blockNumber: number = 1): MockBlock {
  return {
    number: blockNumber,
    hash: `0x${uuidv4().replace(/-/g, '')}`,
    timestamp: Math.floor(Date.now() / 1000) + blockNumber * 1000,
    parentHash: blockNumber > 0 ? `0x${uuidv4().replace(/-/g, '')}` : '0x' + '0'.repeat(64),
    transactions: [`0x${uuidv4().replace(/-/g, '')}`],
  };
}

/**
 * Generate mock transaction receipt
 */
export function createMockTransactionReceipt(hash: string, blockNumber: number = 1): MockTransactionReceipt {
  return {
    transactionHash: hash,
    blockHash: `0x${uuidv4().replace(/-/g, '')}`,
    blockNumber,
    status: 1,
    gasUsed: BigInt(21000),
    logs: [],
  };
}

/**
 * Generate mock event log
 */
export function createMockLog(
  address: string,
  topics: string[],
  data: string = '0x',
  blockNumber: number = 1,
  txHash: string = `0x${uuidv4().replace(/-/g, '')}`,
): MockLog {
  return {
    address,
    topics,
    data,
    blockNumber,
    transactionHash: txHash,
    logIndex: 0,
  };
}