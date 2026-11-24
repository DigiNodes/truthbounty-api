/**
 * Canonical finalized-block ingestion cursor (PREWAVE-BE-001).
 *
 * One monotonic cursor is persisted per (chainId, releaseId). Every row is
 * bound to the release's deployment block and artifact checksum so that data
 * indexed for one release can never be resumed or advanced under another.
 *
 * Four boundaries are tracked separately and never conflated:
 *  - observedHead      highest block the RPC provider reported ("latest")
 *  - safeHead          provider "safe" tag (reorg-unlikely)
 *  - finalizedHead     provider "finalized" tag (canonical, authoritative)
 *  - indexedWatermark  highest finalized block whose effects are projected
 */

export interface ReleaseBinding {
  chainId: number;
  releaseId: string;
  /** First block at which the release's contracts exist on chain. */
  deploymentBlock: bigint;
  /** SHA-256 (lowercase hex) of the release artifact the indexer decodes with. */
  artifactChecksum: string;
}

export interface ChainHeads {
  observedHead: bigint;
  safeHead: bigint;
  finalizedHead: bigint;
  /** When the heads were read from the provider. */
  observedAt: Date;
}

export interface FinalizedCursorRecord {
  chainId: number;
  releaseId: string;
  deploymentBlock: bigint;
  artifactChecksum: string;
  observedHead: bigint | null;
  safeHead: bigint | null;
  finalizedHead: bigint | null;
  headsObservedAt: Date | null;
  indexedWatermark: bigint;
  watermarkBlockHash: string | null;
  watermarkUpdatedAt: Date;
}

/** A finalized canonical event, bound to the chain and release it was decoded for. */
export interface CanonicalEvent {
  chainId: number;
  releaseId: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}

/** A contiguous, inclusive range of finalized blocks and the events inside it. */
export interface FinalizedRange {
  fromBlock: bigint;
  toBlock: bigint;
  /** Canonical hash of `toBlock`, persisted alongside the watermark. */
  toBlockHash: string;
  events: CanonicalEvent[];
}

export type ApplyRangeResult =
  | { status: 'applied'; indexedWatermark: bigint; eventCount: number }
  /** The whole range is already at or below the watermark; no effects ran. */
  | { status: 'duplicate'; indexedWatermark: bigint };

export type RecordHeadsResult =
  | { accepted: true }
  /** Provider reported heads behind what is already persisted; nothing changed. */
  | { accepted: false; reason: 'PROVIDER_LAG' };

export type FinalizedCursorErrorCode =
  | 'INVALID_BINDING'
  | 'INVALID_HEADS'
  | 'INVALID_RANGE'
  | 'NOT_INITIALIZED'
  | 'WRONG_RELEASE'
  | 'NOT_FINALIZED'
  | 'GAP'
  | 'OVERLAP'
  | 'OUT_OF_ORDER'
  | 'DUPLICATE_EVENT'
  | 'CONCURRENT_UPDATE';

export class FinalizedCursorError extends Error {
  constructor(
    readonly code: FinalizedCursorErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FinalizedCursorError';
  }
}

export interface FreshnessPolicy {
  /** Maximum allowed finalizedHead - indexedWatermark before readiness fails. */
  maxIndexLagBlocks: number;
  /** Maximum age of the last provider head observation before readiness fails. */
  maxHeadAgeMs: number;
}

export type CursorNotReadyReason =
  | 'CURSOR_MISSING'
  | 'WRONG_RELEASE'
  | 'HEADS_NEVER_OBSERVED'
  | 'HEADS_STALE'
  | 'INDEX_LAG_EXCEEDED';

/** Sanitized cursor status: block numbers, ages and reason codes only. */
export interface FinalizedCursorStatus {
  chainId: number;
  releaseId: string;
  initialized: boolean;
  ready: boolean;
  reasons: CursorNotReadyReason[];
  observedHead: number | null;
  safeHead: number | null;
  finalizedHead: number | null;
  indexedWatermark: number | null;
  /** observedHead - finalizedHead. */
  finalityLagBlocks: number | null;
  /** finalizedHead - indexedWatermark (never negative). */
  indexLagBlocks: number | null;
  headsObservedAt: string | null;
  headAgeMs: number | null;
  watermarkUpdatedAt: string | null;
  policy: FreshnessPolicy;
}
