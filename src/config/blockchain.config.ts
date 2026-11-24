import { registerAs } from '@nestjs/config';
import { getRuntimeConfig } from './runtime-config';

export default registerAs('blockchain', () => {
  const config = getRuntimeConfig();
  return {
    rpcUrl: config.RPC_URL,
    fallbackRpcUrls: config.BLOCKCHAIN_FALLBACK_RPC_URLS ?? [],
    chainId: config.CHAIN_ID,
    rpcTimeoutMs: config.BLOCKCHAIN_RPC_TIMEOUT_MS,
    contractAddress: config.REWARD_CONTRACT_ADDRESS,
    startBlock: config.START_BLOCK,
    confirmations: {
      safe: config.FINALITY_SAFE_CONFIRMATIONS,
      finalized: config.FINALITY_FINALIZED_CONFIRMATIONS,
      full: config.CONFIRMATIONS_FULL,
    },
    finalityMaxReorgDepth: config.FINALITY_MAX_REORG_DEPTH,
    finalityMaxAncestorSearch: config.FINALITY_MAX_ANCESTOR_SEARCH,
    maxBlocksInMemory: config.BLOCKCHAIN_MAX_BLOCKS,
    maxEventsInMemory: config.BLOCKCHAIN_MAX_EVENTS,
    maxReorgHistoryEntries: config.BLOCKCHAIN_MAX_REORG_HISTORY,
  };
});
