export interface BlockchainEvent<T = Record<string, any>> {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Hash of the block this log was included in. Part of the canonical identity. */
  blockHash: string;
  eventType: string;
  /** Chain the event was ingested from. */
  chainId: number;
  /** Release/artifact provenance the event was decoded against. */
  releaseId: string;
  /** Decoder version used to decode this log. */
  decoderVersion: string;
  /** True when the chain reports this log as removed (reorg). */
  removed?: boolean;
  data: T; // Flexible for different event types
}

export interface TransferEventData {
  from: string;
  to: string;
  amount: string;
  token: string;
}
