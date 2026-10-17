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
 * Opaque Pagination Cursors
 *
 * Cursors are server-signed, versioned, and authenticated. Clients must treat
 * them as opaque and cannot alter position, filters, sort order, route,
 * release context, or expiry without detection.
 */

export const PAGINATION_CURSOR_VERSION = 1 as const;

export type PaginationCursorVersion = typeof PAGINATION_CURSOR_VERSION;

export type PaginationSortDirection = 'asc' | 'desc';

/**
 * Chain-derived context bound into every cursor.
 */
export interface PublicationChainBinding {
  /** Chain ID (e.g. EVM/Cantidle identifier). */
  chainId: string;
  /** Release ID of the deployed artifacts. */
  releaseId: string;
  /** Block number at which the release became effective. */
  deploymentBlock: number;
  /** Sha256 checksum of the deployed artifact bundle. */
  artifactChecksum: string;
}

/**
 * Serializable cursor payload. This is the signed body; it is never trusted
 * without verification against the current or bounded previous signing key.
 */
export interface PaginationCursorPayload {
  /** Cursor format version. */
  v: PaginationCursorVersion;
  /** Stable identifier of the route/schema the cursor belongs to. */
  route: string;
  /** Sort column key. */
  sortField: string;
  /** Sort direction. */
  sortDirection: PaginationSortDirection;
  /** Canonicalized filter set bound into the cursor. */
  filters: Record<string, unknown>;
  /** Last observed sort key value (position). */
  positionKey: string;
  /** Last observed primary identifier (tie-breaker). */
  positionId: string;
  /** Offset advanced by this cursor (for stability under concurrent inserts). */
  offset: number;
  /** Expiry as Unix epoch milliseconds. */
  expiresAtMs: number;
  /** Issued at Unix epoch milliseconds. */
  issuedAtMs: number;
  /** Monotonic sequence number for replay detection within a route. */
  seq: number;
  /** Chain-derived context binding. */
  chain: PublicationChainBinding;
}

/**
 * Signed envelope. The encoded form is `<v>.<base64url(payloadJson)>.<base64url(sig)>` 
 * where the signature is over the canonicalized payload bytes and key id.
 */
export interface PaginationCursorEnvelope {
  version: PaginationCursorVersion;
  /** Opaque key identifier used to sign (never the key material). */
  keyId: string;
  /** Base64url (unpadded) signature bytes. */
  signature: string;
  /** Signed payload. */
  payload: PaginationCursorPayload;
}

/**
 * Result of cursor verification. Failures are classified but must never
 * include signing material, key bytes, or internal stack details.
 */
export type PublicationCursorErrorCode =
  | 'malformed'
  | 'unsupported_version'
  | 'bad-signature'
  | 'expired'
  | 'unknown-key'
  | 'route-mismatch'
  | 'filter-mismatch'
  | 'sort-mismatch'
  | 'chain-mismatch'
  | 'release-mismatch'
  | 'replay-detected'
  | 'offset-out-of-range';

export interface PaginationCursorVerificationFailure {
  ok: false;
  code: PublicationCursorErrorCode;
  /** Safe, non-sensitive message suitable for clients. */
  message: string;
}

export interface PaginationCursorVerificationSuccess {
  ok: true;
  payload: PaginationCursorPayload;
  /** Key id that successfully verified the cursor. */
  keyId: string;
  /** True if the cursor was signed by the bounded previous key during rotation. */
  isPreviousKey: boolean;
}

export type PaginationCursorVerificationResult =
  | PaginationCursorVerificationSuccess
  | PaginationCursorVerificationFailure;

/**
 * Signing key descriptor. Only the key id and public verifier are exposed;
 * secret material is held by the signer implementation and never serialized.
 */
export interface PublicationSigningKeyDescriptor {
  keyId: string;
  /** ISO timestamp when the key became active. */
  activeFrom: string;
  /** ISO timestamp after which the key must not be used to sign. */
  activeUntil?: string;
}

/**
 * Rotation state for cursor signing keys. At most one bounded previous key
 * is accepted for verification during a rotation window.
 */
export interface PublicationKeyRotationState {
  currentKeyId: string;
  /** Bounded previous key id (if rotation is in progress). */
  previousKeyId?: string;
  /** ISO timestamp after which the previous key must be rejected. */
  previousKeyExpiresAt?: string;
}
