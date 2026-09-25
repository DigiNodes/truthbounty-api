import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => {
  const primaryRpc = process.env.BLOCKCHAIN_RPC_URL || 'https://mainnet.optimism.io';
  const fallbackUrlsRaw = process.env.BLOCKCHAIN_FALLBACK_RPC_URLS || '';
  
  const fallbackRpcUrls = fallbackUrlsRaw
    ? fallbackUrlsRaw.split(',').map((url) => url.trim()).filter(Boolean)
    : [];

  return {
    rpcUrl: primaryRpc,
    fallbackRpcUrls,
    chainId: parseInt(process.env.BLOCKCHAIN_CHAIN_ID || '10', 10), // Optimism Mainnet: 10
    rpcTimeoutMs: parseInt(process.env.BLOCKCHAIN_RPC_TIMEOUT_MS || '10000', 10),
    contractAddress: process.env.REWARD_CONTRACT_ADDRESS,
    startBlock: parseInt(process.env.START_BLOCK || '0', 10),
    confirmations: parseInt(process.env.REQUIRED_CONFIRMATIONS || '12', 10),
    // Memory limits for in-memory state service
    maxBlocksInMemory: parseInt(process.env.BLOCKCHAIN_MAX_BLOCKS || '10000', 10),
    maxEventsInMemory: parseInt(process.env.BLOCKCHAIN_MAX_EVENTS || '50000', 10),
    maxReorgHistoryEntries: parseInt(process.env.BLOCKCHAIN_MAX_REORG_HISTORY || '1000', 10),
  };
});
