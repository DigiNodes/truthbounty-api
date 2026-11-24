import { DataState } from '../../../v2/common/data-state.enum';
import { ClaimState } from '../../../domain/claim/claimState';

/**
 * PREWAVE-BE-005 — Versioned Claim List and Claim Detail Read Models.
 *
 * These types define the *published* contract for the versioned claim
 * read-model endpoints. They are the single source of truth the frontend
 * consumes, so field-name and phase inference are never required:
 *
 *  - every response carries its `readModel`/`readModelVersion`,
 *  - every item carries explicit `phase` + `dataState` and a
 *    phase-separated `outcome` (provisional is never serialized as final),
 *  - every chain-derived field is bound to the consumed release
 *    (chainId, releaseId, deploymentBlock, artifactChecksum),
 *  - provenance and freshness accompany every response.
 */

/** Version tag of the published read-model contract. Bump on any breaking change. */
export const CLAIM_READ_MODEL_VERSION = 'claim-read-model/v1';

export const CLAIM_LIST_READ_MODEL = 'claim-list';
export const CLAIM_DETAIL_READ_MODEL = 'claim-detail';

/** Deterministic ordering for the claim list (immutable, keyset-stable). */
export const CLAIM_READ_MODEL_ORDER = 'claimId:asc';

export const CLAIM_READ_MODEL_DEFAULT_LIMIT = 20;
export const CLAIM_READ_MODEL_MAX_LIMIT = 100;

/** Lifecycle states the canonical claim projection can hold. */
export const CLAIM_READ_MODEL_STATES = Object.values(ClaimState);

/** Terminal lifecycle states — a claim in one of these has no further transition. */
export const TERMINAL_CLAIM_STATES: readonly string[] = [
  ClaimState.Finalized,
  ClaimState.Rejected,
  ClaimState.Reorged,
];

export type ClaimReadModelPhase = 'provisional' | 'finalized';
export const CLAIM_READ_MODEL_PHASES: readonly ClaimReadModelPhase[] = [
  'provisional',
  'finalized',
];

export type EvidenceAvailabilityState =
  'available' | 'not_finalized' | 'missing';

export const EVIDENCE_AVAILABILITY_STATES: readonly EvidenceAvailabilityState[] =
  ['available', 'not_finalized', 'missing'];

/** Canonical error codes for fail-closed read-model responses. */
export type ClaimReadModelErrorCode =
  | 'STALE_RECONCILIATION'
  | 'INVALID_ARTIFACT_VERSION'
  | 'UNSUPPORTED_CHAIN'
  | 'NOT_FOUND';

/**
 * Emitted keys must stay in sync with {@link CLAIM_READ_MODEL_ITEM_KEYS} and
 * the response key sets below; the drift test asserts this.
 */
export interface ReleaseProvenance {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

export interface ReadModelFreshness {
  /** Highest projected claim block, or null when nothing is projected. */
  indexedBlock: string | null;
  safeBlock: string | null;
  finalizedBlock: string | null;
  /** Highest block observed from the RPC provider, or null when unknown. */
  observedHead: number | null;
  /** observedHead - indexedBlock (>= 0), or null when either side is unknown. */
  lagBlocks: string | null;
  /** ISO timestamp of the last projection checkpoint advance, or null. */
  lastSuccess: string | null;
  /** True when any {@link staleReasons} is present — callers must fail closed. */
  stale: boolean;
  /** Machine-readable staleness/ambiguity reasons, sorted for determinism. */
  staleReasons: string[];
  /** True when the projection is ahead of the observed chain (reorg suspected). */
  reorgDetected: boolean;
}

export interface EvidenceAvailability {
  state: EvidenceAvailabilityState;
  /** Active (non-removed) evidence records for the claim. */
  activeCount: number;
  /** Active evidence records whose block is at/below the finalized block. */
  finalizedCount: number;
  latestBlockNumber: string | null;
}

export interface ClaimDeadlines {
  /** Canonical verification-round deadline, or null when none is projected. */
  verification: string | null;
  /** Canonical appeal-round deadline, or null when none is projected. */
  appeal: string | null;
  /** When the claim reached a terminal state, or null. */
  settledAt: string | null;
}

export interface ClaimLastEvent {
  blockNumber: string;
  eventIndex: number;
  txHash: string;
  at: string;
}

/**
 * Phase-separated outcome. Exactly one of `provisional` / `final` is non-null:
 * a provisional outcome is never copied into `final`, so a frontend can render
 * "provisional" data without ever presenting it as final.
 */
export interface ClaimOutcome {
  phase: ClaimReadModelPhase;
  provisional: { state: string; settledAt: string | null } | null;
  final: { state: string; settledAt: string | null } | null;
}

export interface ClaimReadModelItem {
  claimId: string;
  chainId: number;
  /** Canonical projected lifecycle state. */
  state: string;
  /** Chain finality of the last applied event (observed/safe/finalized). */
  dataState: DataState;
  phase: ClaimReadModelPhase;
  lastEvent: ClaimLastEvent;
  deadlines: ClaimDeadlines;
  evidence: EvidenceAvailability;
  outcome: ClaimOutcome;
  /** Per-item release binding so a row can never be read out of release. */
  release: ReleaseProvenance;
}

export interface ClaimListPagination {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  order: string;
  /** ISO snapshot pinned for the whole pagination walk. */
  snapshotAt: string;
}

export interface ClaimReadModelListResponse {
  readModel: typeof CLAIM_LIST_READ_MODEL;
  readModelVersion: string;
  observedAt: string;
  provenance: ReleaseProvenance;
  freshness: ReadModelFreshness;
  pagination: ClaimListPagination;
  data: ClaimReadModelItem[];
}

export interface ClaimReadModelDetailResponse {
  readModel: typeof CLAIM_DETAIL_READ_MODEL;
  readModelVersion: string;
  observedAt: string;
  provenance: ReleaseProvenance;
  freshness: ReadModelFreshness;
  data: ClaimReadModelItem;
}

/** Fail-closed error envelope shared by every read-model error response. */
export interface ClaimReadModelErrorBody {
  code: ClaimReadModelErrorCode;
  message: string;
  failClosed: true;
  reason: string;
  /** Best-effort provenance so a client can see what the server would serve. */
  provenance: Partial<ReleaseProvenance> | null;
  expected?: Record<string, unknown>;
  received?: Record<string, unknown>;
}

/**
 * Runtime key manifests. The drift test compares these against the objects the
 * service/view actually emits and against the published fixtures, so a field
 * rename that is not reflected in the contract fails CI.
 */
export const CLAIM_READ_MODEL_ITEM_KEYS: readonly string[] = [
  'claimId',
  'chainId',
  'state',
  'dataState',
  'phase',
  'lastEvent',
  'deadlines',
  'evidence',
  'outcome',
  'release',
];

export const CLAIM_READ_MODEL_LIST_RESPONSE_KEYS: readonly string[] = [
  'readModel',
  'readModelVersion',
  'observedAt',
  'provenance',
  'freshness',
  'pagination',
  'data',
];

export const CLAIM_READ_MODEL_DETAIL_RESPONSE_KEYS: readonly string[] = [
  'readModel',
  'readModelVersion',
  'observedAt',
  'provenance',
  'freshness',
  'data',
];

export const CLAIM_READ_MODEL_PROVENANCE_KEYS: readonly string[] = [
  'chainId',
  'releaseId',
  'deploymentBlock',
  'artifactChecksum',
];
