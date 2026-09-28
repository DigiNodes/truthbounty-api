/**
 * A single raw EVM log as received from the RPC/indexer layer, prior to
 * canonical-identity dedup. Optimism/EVM semantics only: chainId + 0x-hex
 * hashes. No Stellar/Soroban/Freighter concepts belong here.
 */
export interface RawChainLog {
  chainId: number;
  contractAddress: string;
  eventName: string;
  /** Decimal, never a JS float — some EVM chains exceed Number.MAX_SAFE_INTEGER. */
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  blockTimestamp?: Date | null;
  payload: Record<string, unknown>;
  rawArgs: Record<string, unknown>;
}

export type ChainEventIngestOutcome =
  | { status: 'ingested'; id: string }
  | { status: 'duplicate' };

export interface ChainEventIdentity {
  chainId: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
}
