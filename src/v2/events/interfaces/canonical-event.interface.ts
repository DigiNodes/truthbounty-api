/** A single raw EVM log as fetched from RPC, prior to any decoding. */
export interface RawLog {
  chainId: number;
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp?: Date;
}

/** Result of successfully decoding + normalizing one raw log. */
export interface NormalizedEvent {
  chainId: number;
  contractAddress: string;
  artifactVersion: string;
  eventName: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: Date | null;
  actor: string | null;
  claimId: string | null;
  roundId: string | null;
  asset: string | null;
  amount: string | null;
  payload: Record<string, unknown>;
  rawArgs: Record<string, unknown>;
}

export type IngestOutcome =
  | { status: 'ingested'; event: NormalizedEvent }
  | { status: 'duplicate' }
  | { status: 'quarantined'; reason: string };
