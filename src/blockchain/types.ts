/**
 * Core types for blockchain event tracking and reorg handling
 */

export interface BlockInfo {
  number: number;
  hash: string;
  timestamp: number;
  parentHash: string;
}

export interface BlockRecord {
  id: string; // blockNumber:blockHash
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number;
  isCanonical: boolean;
  createdAt: Date;
}

export interface PendingEvent {
  id: string;
  blockNumber: number;
  blockHash: string;
  eventType: string;
  data: Record<string, any>;
  transactionHash: string;
  logIndex: number;
  status: 'pending' | 'confirmed' | 'orphaned';
  confirmations: number;
  createdAt: Date;
  confirmedAt?: Date;
}

export interface ReorgEvent {
  detectedAt: Date;
  reorgDepth: number;
  affectedBlockStart: number;
  affectedBlockEnd: number;
  orphanedEvents: string[]; // event IDs
  reprocessedEvents: string[];
}

export interface ChainState {
  lastProcessedBlock: number;
  lastCanonicalHash: string;
  confirmedDepth: number;
  pendingEventCount: number;
  orphanedEventCount: number;
  lastReorgTime?: Date;
  /**
   * Highest block number observed from the RPC provider (observed head).
   */
  observedHeadBlock?: number;
  /**
   * Block number considered safe (reorg-unlikely) by the provider's finality tags.
   */
  safeBlock?: number;
  /**
   * Block number considered finalized by the provider's finality tags.
   */
  finalizedBlock?: number;
  /**
   * Highest block number to which projections (derived state) have advanced.
   */
  projectionHeadBlock?: number;
  /**
   * Cumulative number of RPC failures observed.
   */
  rpcFailureCount?: number;
  /**
   * Cumulative number of event replays processed (reprocessed after reorg/retry).
   */
  replayCount?: number;
  /**
   * Cumulative number of dead-lettered events (failed past max retries).
   */
  deadLetterCount?: number;
  /**
   * ISO timestamp of the last RPC failure (if any).
   */
  lastRpcErrorAt?: string | null;
  /**
   * Last recorded projection lag (observedHeadBlock - finalizedBlock), >= 0.
   */
  projectionLag?: number;
}

export type IndexerHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Sanitized snapshot of indexer health.
 * Exposes only operational numeric values and a generic runbook link —
 * never credentials, user data, or live RPC URLs.
 */
export interface IndexerHealthSnapshot {
  status: IndexerHealthStatus;
  timestamp: string;
  observedHeadBlock: number;
  safeBlock: number;
  finalizedBlock: number;
  projectionHeadBlock: number;
  /** Finalized canonical blocks not yet applied to projections (>= 0). */
  indexerLagBlocks: number;
  /** Observed head distance from the finalized cursor (>= 0). */
  finalityLagBlocks: number;
  projectionLag: number;
  rpcFailureCount: number;
  replayCount: number;
  deadLetterCount: number;
  alertThresholds: {
    indexerLagBlocks: number;
    finalityLagBlocks: number;
    /** @deprecated Retained as an alias for finalityLagBlocks. */
    projectionLagBlocks: number;
    rpcFailureRateWindow: number;
    maxDeadLetters: number;
  };
  runbookUrl: string;
}

export interface StateMemoryStats {
  currentBlockCount: number;
  currentEventCount: number;
  currentReorgHistoryCount: number;
  maxBlocksInMemory: number;
  maxEventsInMemory: number;
  maxReorgHistoryEntries: number;
  confirmedEventCount: number;
  pendingEventCount: number;
  orphanedEventCount: number;
}

/**
 * Verification and Voting Types
 */

export type Verdict = 'TRUE' | 'FALSE' | 'UNSURE';

export interface VerificationVote {
  claimId: string;
  userId: string;
  verdict: Verdict;
  stakeAmount: string; // BigInt as string
  userReputation: number;
  timestamp: Date;
  eventId: string; // Reference to blockchain event
}

export interface WeightedVote {
  claimId: string;
  userId: string;
  verdict: Verdict;
  stakeAmount: string;
  userReputation: number;
  weight: number; // Calculated weight
  timestamp: Date;
}

export interface VoteAggregation {
  claimId: string;
  totalWeight: number;
  verdictWeights: Record<Verdict, number>;
  voterCount: number;
  votes: WeightedVote[];
}

export interface ClaimResolution {
  claimId: string;
  resolvedVerdict: Verdict | 'UNRESOLVED';
  confidenceScore: number; // 0.0 to 1.0
  resolutionMargin: number; // Difference between top two verdicts
  totalWeight: number;
  voterCount: number;
  verdictDistribution: Record<Verdict, number>;
  metadata: {
    timestamp: Date;
    dominantVerdictWeight: number;
    secondVerdictWeight: number;
    isTie: boolean;
    isLowConfidence: boolean;
  };
}

export interface ResolutionConfig {
  minTotalWeight: number; // Minimum weight to resolve
  confidenceThreshold: number; // Minimum confidence (0.0-1.0)
  maxReputationShare: number; // Max % one user can contribute (0.0-1.0)
  tieThreshold: number; // Margin threshold for ties
}

/**
 * Resumable WebSocket Stream Types (PREWAVE-BE-008)
 *
 * Versioned stream envelopes carry event IDs, cursors, chain/release binding,
 * block metadata, freshness, and projection version so clients can reconcile
 * against canonical read models and detect gaps, duplicates, expiry, and
 * release rollovers. Envelopes expose no protected payload.
 */

/** Current envelope schema version. Bump on any breaking change. */
export const STREAM_ENVELOPE_VERSION = 1 as const;
export type StreamEnvelopeVersion = typeof STREAM_ENVELOPE_VERSION;

/** Freshness class of the data carried by an envelope. */
export type StreamFreshness = 'pending' | 'confirmed' | 'finalized' | 'orphaned';

/**
 * Chain and release binding for all chain-derived stream data.
 */
export interface StreamChainBinding {
  /** EIP-155 chain ID (e.g. 11155420 for Optimism Sepolia). */
  chainId: number;
  /** Opaque release identifier for the deployment artifact set. */
  releaseId: string;
  /** Block number at which the release contracts were deployed. */
  deploymentBlock: number;
  /** Hex-encoded artifact checksum binding the release artifacts. */
  artifactChecksum: string;
}

/**
 * Opaque cursor position within the stream. Cursors are monotonically
 * increasing within a chain/release binding.
 */
export interface StreamCursor {
  /** Monotonically increasing sequence number within the binding. */
  sequence: number;
  /** Block number of the last delivered event. */
  blockNumber: number;
  /** Log index within the block (for deterministic ordering). */
  logIndex: number;
}

/**
 * Versioned stream envelope. Exposes only operational metadata and a
 * public event reference — never protected payload, secrets, or authorization
 * material.
 */
export interface StreamEnvelope {
  /** Envelope schema version. */
  version: StreamEnvelopeVersion;
  /** Stable event ID derived from chain data (txHash:logIndex). */
  eventId: string;
  /** Cursor position of this event in the stream. */
  cursor: StreamCursor;
  /** Chain and release binding. */
  binding: StreamChainBinding;
  /** Block number of the event. */
  blockNumber: number;
  /** Block hash of the event (for reorg detection). */
  blockHash: string;
  /** Freshness class of the event. */
  freshness: StreamFreshness;
  /** Projection version the event was applied to. */
  projectionVersion: number;
  /** Public event type (e.g. 'ClaimCreated'). */
  eventType: string;
  /** ISO timestamp of envelope creation. */
  emittedAt: string;
}

/**
 * Opaque resume token issued to clients for reconnection. Tokens are
 * bound to a chain/release binding and expire after a bounded window.
 */
export interface ResumeToken {
  /** Opaque token string (never contains secrets). */
  token: string;
  /** Cursor to resume from. */
  cursor: StreamCursor;
  /** Binding the token was issued for. */
  binding: StreamChainBinding;
  /** ISO timestamp at which the token expires. */
  expiresAt: string;
}

/** Reason a resume attempt was rejected. */
export type ResumeRejectionReason =
  | 'expired-token'
  | 'release-changed'
  | 'chain-changed'
  | 'gap-detected'
  | 'invalid-token';

/**
 * Result of a resume attempt. Fails closed: any anomaly forces a bounded
 * canonical resync rather than silently continuing.
 */
export type ResumeResult =
  | { ok: true; cursor: StreamCursor }
  | { ok: false; reason: ResumeRejectionReason; resyncFrom: StreamCursor };

/**
 * Bounded backfill request for HTTP resync after a gap, expiry, or release
 * rollover. Requests are clamped to a maximum count and must carry the
 * binding to prevent cross-chain or cross-release contamination.
 */
export interface BackfillRequest {
  /** Binding the request is scoped to. */
  binding: StreamChainBinding;
  /** Cursor to begin backfill from (exclusive). */
  fromCursor: StreamCursor;
  /** Maximum number of envelopes to return. */
  limit: number;
  /** ISO timestamp of request creation. */
  requestedAt: string;
}

/** Bounded backfill response. */
export interface BackfillResponse {
  /** Binding the response is scoped to. */
  binding: StreamChainBinding;
  /** Envelopes in the backfill window. */
  envelopes: StreamEnvelope[];
  /** True when the backfill window is exhausted and a full resync is required. */
  resyncRequired: boolean;
  /** Reason for resync when resyncRequired is true. */
  resyncReason?: ResumeRejectionReason;
  /** Next resume token for continuation. */
  nextResumeToken?: ResumeToken;
}
