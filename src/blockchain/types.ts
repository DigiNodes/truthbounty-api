/*
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
 * Realtime configuration and topic authorization types
 * (PREWAVE-BE-035)
 */

/**
 * Public data policy for a stream topic. Protected payloads require a
 * capability and are never coalesced with public payloads.
 */
export type RealtimeTopicVisibility = 'public' | 'protected';

/**
 * Supported release binding for realtime streams. Streams must be bound to
 * a chain ID, release ID, deployment block, and artifact checksum.
 */
export interface RealtimeReleaseBinding {
  chainId: string;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

/**
 * A single approved stream topic definition.
 */
export interface RealtimeTopicDefinition {
  /** Canonical topic name. Must match the strict topic pattern. */
  name: string;
  /** Public or protected visibility. */
  visibility: RealtimeTopicVisibility;
  /** Capabilities required to subscribe (empty for public topics). */
  requiredCapabilities: string[];
  /** Maximum permitted payload size in bytes for this topic. */
  maxPayloadBytes: number;
  /** Retention window in seconds for backfill/replay. */
  retentionSeconds: number;
  /** Heartbeat interval in seconds. */
  heartbeatSeconds: number;
}

/**
 * Stream origin allow-list entry. Origins are matched exactly; wildcards
 * are not permitted.
 */
export interface RealtimeOriginAllowEntry {
  origin: string;
  /** Optional capabilities required to connect from this origin. */
  requiredCapabilities?: string[];
}

/**
 * Validated realtime configuration. Invalid config must fail startup/readiness.
 */
export interface RealtimeConfig {
  /** Release binding the config to a chain/release/deployment/artifact. */
  release: RealtimeReleaseBinding;
  /** Approved stream topics. */
  topics: RealtimeTopicDefinition[];
  /** Allowed stream origins. */
  origins: RealtimeOriginAllowEntry[];
  /** Default heartbeat interval in seconds (topic overrides allowed). */
  defaultHeartbeatSeconds: number;
  /** Default retention window in seconds (topic overrides allowed). */
  defaultRetentionSeconds: number;
  /** Global maximum payload size in bytes. */
  maxPayloadBytes: number;
  /** Maximum number of subscriptions per session. */
  maxSubscriptionsPerSession: number;
  /** Maximum number of concurrent sessions per principal. */
  maxSessionsPerPrincipal: number;
  /** Supported release IDs. Config releaseID must be in this list. */
  supportedReleaseIds: string[];
}

/**
 * Principal subscription context used for topic authorization.
 */
export interface RealtimePrincipal {
  principalId: string;
  capabilities: string[];
  /** Session revocation timestamp; revoked sessions must be rejected. */
  revokedAt?: Date | null;
}

/**
 * Result of authorizing a topic subscription request.
 */
export type RealtimeTopicAuthorizationResult =
  | { ok: true; topic: RealtimeTopicDefinition }
  | { ok: false; reason: RealtimeTopicAuthorizationFailureReason };

export type RealtimeTopicAuthorizationFailureReason =
  |'unknown_topic'
  | 'wildcard_not_allowed'
  | 'invalid_topic_name'
  | 'missing_capability'
  | 'revoked_session'
  | 'origin_not_allowed'
  | 'stale_release';

/**
 * Result of validating a payload against the authorized topic and config.
 */
export type RealtimePayloadValidationResult =
  | { ok: true }
  | { ok: false; reason: 'oversized_payload' | 'visibility_mismatch' };
