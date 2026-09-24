import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  rpcUrl:
    process.env.BLOCKCHAIN_RPC_URL || 'https://mainnet.infura.io/v3/YOUR_KEY',
  chainId: parseInt(process.env.CHAIN_ID || '1', 10),
  contractAddress: process.env.REWARD_CONTRACT_ADDRESS,
  startBlock: parseInt(process.env.START_BLOCK || '0', 10),
  confirmations: {
    safe: parseInt(process.env.CONFIRMATIONS_SAFE || '6', 10),
    finalized: parseInt(process.env.CONFIRMATIONS_FINALIZED || '12', 10),
    full: parseInt(process.env.CONFIRMATIONS_FULL || '64', 10),
  },
  maxBlocksInMemory: parseInt(process.env.BLOCKCHAIN_MAX_BLOCKS || '10000', 10),
  maxEventsInMemory: parseInt(process.env.BLOCKCHAIN_MAX_EVENTS || '50000', 10),
  maxReorgHistoryEntries: parseInt(
    process.env.BLOCKCHAIN_MAX_REORG_HISTORY || '1000',
    10,
  ),
}));
