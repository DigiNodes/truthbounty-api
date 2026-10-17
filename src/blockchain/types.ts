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
