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
  status: 'Pending' | 'confirmed' | 'orphaned';
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

/**
 * Protocol binding and release authority types.
 *
 * All chain-derived data must be bound to chain ID, release ID, deployment block,
 * and artifact checksum so that missing, stale, ambiguous, or wrong-release
 * data fails closed.
 */

export interface ChainReleaseBinding {
  /**
   * Numeric chain ID of the network the data was derived from (e.g. Optimism Sepolia).
   */
  chainId: number;
  /** Numeric deployment block number of the authoritative contracts. */
  deploymentBlock: number;
  /** Content address of the deployment artifact for this release. */
  deploymentAddress: string;
  /** Stable release identifier (canonical release ID). */
  releaseId: string;
  /** Hash of the deployment artifact manifest (checksum). */
  artifactChecksum: string;
}

export type DataFreshness = 'fresh' | 'stale';

export type DataAvailability = 'available' | 'unavailable';

/**
 * State of a projection with respect to authoritative chain data.
 * These states are mutually exclusive and fail closed: only 'ok' permits
 * consumers to treat the projection as authoritative.
 */
export type ProjectionStatus =
  | 'ok'
  | 'unavailable'
  | 'ineligible'
  | 'stale'
  | 'wrong-release';

/**
 * Reason codes for non-ok projection states. Stable for client consumption.
 */
export type ProjectionReasonCode =
  | 'missing-chain-data'
  | 'missing-release-binding'
  | 'chain-id-mismatch'
  | 'release-id-mismatch'
  | 'deployment-block-mismatch'
  | 'artifact-checksum-mismatch'
  | 'pre-deployment-block'
  | 'not-registered'
  | 'stake-below-minimum'
  | 'reputation-below-minimum'
  | 'verifier-inactive'
  | 'verifier-slashed'
  | 'assignment-missing'
  | 'assignment-mismatch'
  | 'phase-closed'
  | 'deadline-passed'
  | 'stale-projection-head'
  | 'reorg-detected'
  | 'finality-lag-exceeded'
  | 'unknown';

/**
 * Provenance for a single chain-derived value. Every authoritative number on
 * a projection must reference its source so consumers can verify it.
 */
export interface SourceReference {
  /** Canonical event type that produced the value. */
  eventType: string;
  /** Transaction hash of the canonical event. */
  transactionHash: string;
  /** Log index within the transaction. */
  logIndex: number;
  /** Block number of the canonical event. */
  blockNumber: number;
  /** Block hash of the canonical event. */
  blockHash: string;
  /** Chain ID the event was observed on. */
  chainId: number;
  /** Release ID the event was observed under. */
  releaseId: string;
  /** Artifact checksum of the deployment that emitted the event. */
  artifactChecksum: string;
}

/**
 * Stake input for a verifier, derived from canonical contract state.
 */
export interface VerifierStakeInput {
  /** Staked amount as a BigInt string. */
  amount: string;
  /** Minimum stake required for eligibility as a BigInt string. */
  minimumRequired: string;
  /** Whether the stake meets the minimum. */
  meetsMinimum: boolean;
  /** Source of the stake value. */
  source: SourceReference;
}

/**
 * Reputation input for a verifier, derived from canonical contract state.
 */
export interface VerifierReputationInput {
  /** Reputation score as a BigInt string. */
  score: string;
  /** Minimum reputation required for eligibility as a BigInt string. */
  minimumRequired: string;
  /** Whether the reputation meets the minimum. */
  meetsMinimum: boolean;
  /** Source of the reputation value. */
  source: SourceReference;
}

/**
 * Effective weight provenance. The effective weight must always carry the
 * authoritative source references for the stake and reputation inputs that
 * contributed to it.
 */
export interface EffectiveWeightProvenance {
  /** Computed effective weight as a BigInt string. */
  weight: string;
  /** Stake input used in the weight computation. */
  stake: VerifierStakeInput;
  /** Reputation input used in the weight computation. */
  reputation: VerifierReputationInput;
  /** Source of the weight computation ruleset (contract event). */
  source: SourceReference;
}

/**
 * Verifier readiness projection. Derived from canonical contract state.
 */
export interface VerifierReadiness {
  verifierId: string;
  status: ProjectionStatus;
  reasonCode?: ProjectionReasonCode;
  /** Whether the verifier is registered in the authority contract. */
  registered: boolean;
  /** Whether the verifier is currently active. */
  active: boolean;
  /** Whether the verifier has been slashed. */
  slashed: boolean;
  /** Stake input and provenance. */
  stake: VerifierStakeInput;
  /** Reputation input and provenance. */
  reputation: VerifierReputationInput;
  /** Effective weight provenance. */
  effectiveWeight: EffectiveWeightProvenance;
  /** Chain/release binding for this projection. */
  binding: ChainReleaseBinding;
  /** Freshness of the underlying chain data. */
  freshness: DataFreshness;
  /** Block number of the last canonical event applied to this projection. */
  projectionHeadBlock: number;
  /** ISO timestamp the projection was derived. */
  derivedAt: string;
}

/**
 * Phase of a claim verification cycle, derived from canonical contract state.
 */
export type VerificationPhase =
  | 'unassigned'
  | 'assigned'
  | 'commitment'
  | 'reveal'
  | 'closed'
  | 'settled';

/**
 * Deadline projection for a phase. All values originate from canonical
 * contract state.
 */
export interface PhaseDeadline {
  phase: VerificationPhase;
  /** Deadline as a Unix timestamp (seconds). */
  deadlineTimestamp: number;
  /** Whether the deadline has passed as of derivation. */
  passed: boolean;
  /** Source of the deadline value. */
  source: SourceReference;
}

/**
 * Assignment projection for a verifier on a claim.
 */
export interface VerifierAssignment {
  claimId: string;
  verifierId: string;
  status: ProjectionStatus;
  reasonCode?: ProjectionReasonCode;
  /** Whether the verifier is assigned to the claim. */
  assigned: boolean;
  /** Source of the assignment. */
  source: SourceReference;
}

/**
 * Commitment projection. Exposes only the existence of a commitment and its
 * source — never the commitment hash precontents or rationale.
 */
export interface CommitmentProjection {
  claimId: string;
  verifierId: string;
  status: ProjectionStatus;
  reasonCode?: ProjectionReasonCode;
  /** Whether a commitment has been recorded for this verifier/claim. */
  committed: boolean;
  /** Source of the commitment existence (not its preimage). */
  source: SourceReference;
}

/**
 * Reveal requirement projection. Determines whether a verifier must reveal
 * and whether they have revealed. Does not expose the revealed verdict or stake
 * until canonical reveal is finalized.
 */
export interface RevealRequirementProjection {
  claimId: string;
  verifierId: string;
  status: ProjectionStatus;
  reasonCode?: ProjectionReasonCode;
  /** Whether a reveal is required for this verifier/claim. */
  required: boolean;
  /** Whether the reveal has been recorded canonically. */
  revealed: boolean;
  /** Whether the reveal requirement was missed (deadline passed, no reveal). */
  missed: boolean;
  /** Source of the reveal requirement and state. */
  source: SourceReference;
}

/**
 * Realtime Backpressure and SlowConsumer Isolation Types
 *
 * These types define the bounded per-connection queue, drop/disconnect policy,
 * heartbeat, and catch-up handoff contracts used to prevent a single slow
 * client from exhausting shared worker memory.
 */

/**
 * Policy applied when a per-connection queue exceeds its bound.
 * - `drop-oldest`: evict the oldest queued message to make room (resumable).
 * - `drop-newest`: reject the incoming message (resumable).
 * - `disconnect`: close the connection and require reconnect + catch-up.
 */
export type BackpressurePolicy = 'drop-oldest' | 'drop-newest' | 'disconnect';

/**
 * Reason a connection was dropped or a message was discarded.
 * Used for auditability and to drive the client's recovery path.
 */
export type BackpressureDropReason =
  | 'queue_overflow'
  | 'slow_consumer'
  | 'heartbeat_timeout'
  | 'shutdown'
  | 'unauthorized'
  | 'stale_cursor';

/**
 * Bounded per-connection queue configuration.
 * All limits are enforced per connection; no shared unbounded buffer exists.
 */
export interface ConnectionQueueConfig {
  /** Maximum number of messages buffered per connection. */
  maxQueueDepth: number;
  /** Maximum total buffered bytes per connection (approximate). */
  maxQueueBytes: number;
  /** Policy applied when either bound is exceeded. */
  overflowPolicy: BackpressurePolicy;
  /** Interval between heartbeat pings, in milliseconds. */
  heartbeatIntervalMs: number;
  /** Time without a heartbeat ack before the connection is considered lost. */
  heartbeatTimeoutMs: number;
  /** Maximum time a slow consumer may remain before forced disconnect. */
  slowConsumerGraceMs: number;
}

/**
 * A single queued realtime message with a monotonic sequence number so that
 * dropped clients can resume from a known cursor.
 */
export interface QueuedRealtimeMessage<T = unknown> {
  /** Monotonic per-connection sequence number. */
  sequence: number;
  /** Chain ID the message is bound to. */
  chainId: number;
  /** Release ID the message is bound to. */
  releaseId: string;
  /** Deployment block the message is bound to. */
  deploymentBlock: number;
  /** Artifact checksum the message is bound to. */
  artifactChecksum: string;
  /** Event type discriminator (never contains protected payload). */
  eventType: string;
  /** Canonical event ID, if applicable. */
  eventId?: string;
  /** Opaque payload; must not be logged on overflow. */
  payload: T;
  /** Approximate serialized size in bytes. */
  sizeBytes: number;
  /** Enqueue timestamp (ms since epoch). */
  enqueuedAt: number;
}

/**
 * Per-connection backpressure and heartbeat state.
 * Bounded by construction: `queue` length never exceeds `config.maxQueueDepth`.
 */
export interface ConnectionBackpressureState {
  connectionId: string;
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  config: ConnectionQueueConfig;
  /** Bounded FIFO queue. */
  queue: QueuedRealtimeMessage[];
  /** Total buffered bytes (approximate). */
  bufferedBytes: number;
  /** Last sequence number successfully delivered to the client. */
  lastDeliveredSequence: number;
  /** Last sequence number enqueued. */
  lastEnqueuedSequence: number;
  /** Last heartbeat ack timestamp (ms since epoch). */
  lastHeartbeatACkAt: number;
  /** Whether the connection is currently considered slow. */
  isSlowConsumer: boolean;
  /** Whether the connection has been dropped. */
  isDropped: boolean;
  /** Reason for the most recent drop, if any. */
  dropReason?: BackpressureDropReason;
}

/**
 * Catch-up handoff descriptor returned to a dropped client so it can resume
 * from a known cursor without replaying the entire stream.
 */
export interface CatchUpHandoff {
  connectionId: string;
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  /** Sequence number the client should resume from (exclusive). */
  resumeFromSequence: number;
  /** Reason the connection was dropped. */
  dropReason: BackpressureDropReason;
  /** ISO timestamp when the handoff was issued. */
  issuedAt: string;
  /** Whether the client must re-authenticate before resuming. */
  requiresReauth: boolean;
}

/**
 * Sanitized backpressure metrics for observability.
 * Never includes payloads, credentials, or live RPC URLs.
 */
export interface BackpressureMetricsSnapshot {
  timestamp: string;
  activeConnections: number;
  droppedConnections: number;
  slowConsumerCount: number;
  totalQueueDepth: number;
  maxQueueDepthObserved: number;
  totalBufferedBytes: number;
  maxBufferedBytesObserved: number;
  overflowDropCount: number;
  heartbeatTimeoutCount: number;
  catchUpHandoffCount: number;
}