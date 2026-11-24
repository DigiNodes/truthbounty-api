import { DataState } from '../../common/data-state.enum';
import { DisputeStatus } from '../entities/project-dispute.entity';

/**
 * PREWAVE-BE-007 — Versioned Dispute, Appeal, and Settlement Read Models.
 *
 * These types define the *published* contract for the versioned dispute
 * read-model endpoints. They are the single source of truth the frontend
 * consumes, so field-name and phase inference are never required:
 *
 *  - every response carries its `readModel`/`readModelVersion`,
 *  - every item carries explicit `phase` + `dataState` and a
 *    phase-separated `outcome` (provisional is never serialized as final),
 *  - every chain-derived field is bound to the consumed release
 *    (chainId, releaseId, deploymentBlock, artifactChecksum),
 *  - provenance and freshness accompany every response.
 *
 * Authoritative inputs are chain-derived only: the canonical dispute projection
 * (`v2_project_dispute`), the verification rounds, and the reward/settlement
 * projections. The API never mutates protocol state and never invents fields.
 */

/** Version tag of the published read-model contract. Bump on any breaking change. */
export const DISPUTE_READ_MODEL_VERSION = 'dispute-read-model/v1';

export const DISPUTE_REGISTER_READ_MODEL = 'dispute-register';
export const DISPUTE_DETAIL_READ_MODEL = 'dispute-detail';

/** Deterministic ordering for the dispute register (immutable, keyset-stable). */
export const DISPUTE_READ_MODEL_ORDER = 'disputeId:asc';

export const DISPUTE_READ_MODEL_DEFAULT_LIMIT = 20;
export const DISPUTE_READ_MODEL_MAX_LIMIT = 100;

/** Lifecycle states the canonical dispute projection can hold. */
export const DISPUTE_READ_MODEL_STATES = Object.values(DisputeStatus);

/** Terminal lifecycle states — a dispute in one of these has no further transition. */
export const TERMINAL_DISPUTE_STATES: readonly string[] = [
  DisputeStatus.RESOLVED,
  DisputeStatus.EXPIRED,
];

export type DisputeReadModelPhase = 'provisional' | 'appealable' | 'finalized';
export const DISPUTE_READ_MODEL_PHASES: readonly DisputeReadModelPhase[] = [
  'provisional',
  'appealable',
  'finalized',
];

export type BondDisposition = 'locked' | 'refunded' | 'slashed' | 'unknown';

export type AppealAvailabilityReason =
  | 'window_open'
  | 'deadline_passed'
  | 'already_final'
  | 'max_round'
  | 'no_deadline';

export const APPEAL_AVAILABILITY_REASONS: readonly AppealAvailabilityReason[] = [
  'window_open',
  'deadline_passed',
  'already_final',
  'max_round',
  'no_deadline',
];

/** Canonical error codes for fail-closed read-model responses. */
export type DisputeReadModelErrorErrorCode =
  | 'STALE_RECONCILIATION'
  | 'INVALID_ARTIFACT_VERSION'
  | 'UNSUPPORTED_CHAIN'
  | 'NOT_FOUND';

/**
 * Emitted keys must stay in sync with {@link DISPUTE_READ_MODEL_ITEM_KEYS} and
 * the response key sets below; the drift test asserts this.
 */
export interface ReleaseProvenance {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

export interface ReadModelFreshness {
  /** Highest projected dispute block, or null when nothing is projected. */
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

export interface DisputeLastEvent {
  blockNumber: string;
  eventIndex: number;
  txHash: string;
  at: string;
}

export interface DisputeDeadlines {
  /** Canonical dispute deadline (when challenge bond must be posted), or null. */
  dispute: string | null;
  /** Canonical appeal deadline, or null when none is projected. */
  appeal: string | null;
  /** When the dispute reached a terminal state, or null. */
  settledAt: string | null;
}

export interface DisputeBond {
  /** Exact integer string amount (never a float/number). */
  amount: string | null;
  /** Asset address (e.g., token contract). */
  asset: string | null;
  /** Disposition of the bond (contract-derived). */
  disposition: BondDisposition;
}

export interface DisputeAppeal {
  /** Whether an appeal is currently available (contract-derived). */
  available: boolean;
  /** Appeal round ID when available, or null. */
  appealRoundId: string | null;
  /** Machine-readable reason for availability decision. */
  reason: AppealAvailabilityReason;
}

/**
 * Phase-separated outcome. Exactly one of `provisional` / `final` is non-null:
 * a provisional outcome is never copied into `final`, so a frontend can render
 * "provisional" data without ever presenting it as final.
 */
export interface DisputeOutcome {
  phase: DisputeReadModelPhase;
  provisional: {
    status: string;
    outcome: string | null;
    deadline: string | null;
  } | null;
  final: {
    status: 'resolved' | 'expired';
    outcome: string | null;
    settledAt: string | null;
  } | null;
}

export interface DisputeTimelineEvent {
  ref: 'raise' | 'resolved' | 'expired';
  txHash: string;
  logIndex: number;
  blockNumber: string;
  at: string;
}

export interface DisputeSettlement {
  /** Whether settlement is pending for this dispute. */
  pending: boolean;
  /** Settlement state when available (contract-derived). */
  state: string | null;
  /** Exact reward amount string if applicable, or null. */
  rewardAmount: string | null;
  /** Exact refund amount string if applicable, or null. */
  refundAmount: string | null;
  /** Exact slashed amount string if applicable, or null. */
  slashedAmount: string | null;
}

export interface DisputeReadModelItem {
  disputeId: string;
  claimId: string;
  originalRoundId: string;
  chainId: number;
  /** Canonical projected lifecycle state. */
  status: string;
  /** Chain finality of the last applied event (observed/safe/finalized). */
  dataState: DataState;
  phase: DisputeReadModelPhase;
  lastEvent: DisputeLastEvent;
  deadlines: DisputeDeadlines;
  bond: DisputeBond;
  appeal: DisputeAppeal;
  outcome: DisputeOutcome;
  settlement: DisputeSettlement;
  timeline: DisputeTimelineEvent[];
  /** Per-item release binding so a row can never be read out of release. */
  release: ReleaseProvenance;
}

export interface DisputeListPagination {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  order: string;
  /** ISO snapshot pinned for the whole pagination walk. */
  snapshotAt: string;
}

export interface DisputeReadModelListResponse {
  readModel: typeof DISPUTE_REGISTER_READ_MODEL;
  readModelVersion: string;
  observedAt: string;
  provenance: ReleaseProvenance;
  freshness: ReadModelFreshness;
  pagination: DisputeListPagination;
  data: DisputeReadModelItem[];
}

export interface DisputeReadModelDetailResponse {
  readModel: typeof DISPUTE_DETAIL_READ_MODEL;
  readModelVersion: string;
  observedAt: string;
  provenance: ReleaseProvenance;
  freshness: ReadModelFreshness;
  data: DisputeReadModelItem;
}

/** Fail-closed error envelope shared by every read-model error response. */
export interface DisputeReadModelErrorBody {
  code: DisputeReadModelErrorErrorCode;
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
export const DISPUTE_READ_MODEL_ITEM_KEYS: readonly string[] = [
  'disputeId',
  'claimId',
  'originalRoundId',
  'chainId',
  'status',
  'dataState',
  'phase',
  'lastEvent',
  'deadlines',
  'bond',
  'appeal',
  'outcome',
  'settlement',
  'timeline',
  'release',
];

export const DISPUTE_READ_MODEL_LIST_RESPONSE_KEYS: readonly string[] = [
  'readModel',
  'readModelVersion',
  'observedAt',
  'provenance',
  'freshness',
  'pagination',
  'data',
];

export const DISPUTE_READ_MODEL_DETAIL_RESPONSE_KEYS: readonly string[] = [
  'readModel',
  'readModelVersion',
  'observedAt',
  'provenance',
  'freshness',
  'data',
];

export const DISPUTE_READ_MODEL_PROVENANCE_KEYS: readonly string[] = [
  'chainId',
  'releaseId',
  'deploymentBlock',
  'artifactChecksum',
];
