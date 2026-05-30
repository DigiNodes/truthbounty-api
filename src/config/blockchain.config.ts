import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  rpcUrl:
    process.env.BLOCKCHAIN_RPC_URL || 'https://mainnet.infura.io/v3/YOUR_KEY',
  contractAddress: process.env.REWARD_CONTRACT_ADDRESS,
  startBlock: parseInt(process.env.START_BLOCK || '0', 10),
  confirmations: parseInt(process.env.REQUIRED_CONFIRMATIONS || '12', 10),
  // Memory limits for in-memory state service (prevents OOM)
  maxBlocksInMemory: parseInt(process.env.BLOCKCHAIN_MAX_BLOCKS || '10000', 10),
  maxEventsInMemory: parseInt(process.env.BLOCKCHAIN_MAX_EVENTS || '50000', 10),
  maxReorgHistoryEntries: parseInt(process.env.BLOCKCHAIN_MAX_REORG_HISTORY || '1000', 10),
}));
