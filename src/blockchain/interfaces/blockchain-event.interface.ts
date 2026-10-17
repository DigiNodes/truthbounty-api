export interface BlockchainEvent<T = Record<string, any>> {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventType: string;
  data: T; // Flexible for different event types
}

export interface TransferEventData {
  from: string;
  to: string;
  amount: string;
  token: string;
}

/**
 * Versioned stream envelope contract for resumable WebSocket delivery.
 *
 * Every envelope is self-describing and binds chain-derived data to chain ID,
 * release ID, deployment block, and artifact checksum so clients can fail
 * closed on missing, stale, ambiguous, or wrong-release data.
 */
export interface StreamEnvelope<T = Record<string, any>> {
  /** Envelope schema version. Clients must reject unknown versions. */
  schemaVersion: '1';
  /** Monotonically increasing per-stream event ID. */
  eventId: string;
  /** Opaque cursor to acknowledge up to this event. */
  cursor: string;
  /** Chain ID the event was derived from. */
  chainId: number;
  /** Release ID of the deployment artifacts. */
  releaseId: string;
  /** Deployment block for the release. */
  deploymentBlock: number;
  /** Checksum of the deployment artifacts. */
  artifactChecksum: string;
  /** Block number of the event. */
  blockNumber: number;
  /** Freshness metadata for the event. */
  freshness: StreamFreshness;
  /** Projection version the event was projected with. */
  projectionVersion: string;
  /** Event type discriminator. */
  eventType: string;
  /** Public event payload. Must never contain secrets or protected data. */
  data: T;
}

export type StreamFreshnessLevel = 'finalized' | 'confirmed' | 'pending';

export interface StreamFreshness {
  level: StreamFreshnessLevel;
  /** Number of confirmations at delivery time. */
  confirmations: number;
  /** Timestamp (ms) when freshness was evaluated. */
  evaluatedAt: number;
}

export interface ResumeToken {
  /** Opaque token string presented by clients on reconnect. */
  token: string;
  /** Expiry timestamp (ms) after which the token is invalid. */
  expiresAt: number;
}

export interface StreamBackfillRequest {
  /** Opaque resume token issued on disconnect. */
  resumeToken: string;
  /** Maximum number of events to return. */
  limit: number;
}

export interface StreamBackfillResponse<T = Record<string, any>> {
  envelopes: StreamEnvelope<T>[];
  /** True when the backfill window is exhausted and a full resync is required. */
  resyncRequired: boolean;
  /** Reason for resync when resyncRequired is true. */
  resyncReason?: StreamFailureReason;
  /** Next resume token for continuation. */
  nextResumeToken?: ResumeToken;
}

export type StreamFailureReason =
  | 'expired_token'
  | 'gap_detected'
  | 'release_changed'
  | 'chain_changed';
