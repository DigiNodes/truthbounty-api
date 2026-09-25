import { DataState } from '../common/data-state.enum';

export type ProjectionStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Per-projector projection freshness and finality metadata (issue408).
 *
 * Read-only, derived state. Joins the durable per-projector cursor
 * (`v2_projector_cursors`) with the finality checkpoints
 * (`v2_event_checkpoints`) and the live indexer snapshot
 * (`BlockchainStateService.getIndexerHealth()`).
 *
 * Block heights are strings (bigint-safe); distances are strings so values
 * beyond Number.MAX_SAFE_INTEGER never lose precision.
 */
export interface ProjectionFreshness {
  projectorName: string;
  /** Highest canonical-event block the projector has applied, or null if never ran. */
  indexedBlock: string | null;
  indexedLogIndex: number | null;
  /** Highest finalized block known (DB checkpoint primary, indexer snapshot fallback). */
  finalizedHeight: string | null;
  /** Highest safe block known (DB checkpoint primary, indexer snapshot fallback). */
  safeHeight: string | null;
  /** Highest block observed from the RPC provider, or null when unknown. */
  observedHead: number | null;
  /** observedHead - indexedBlock (>= 0), or null when either side is unknown. */
  headDistance: string | null;
  /** ISO timestamp of the cursor's last advance, or null if never ran. */
  lastSuccess: string | null;
  status: ProjectionStatus;
  /** Machine-readable degraded reasons joined by '; ', or null when healthy. */
  degradedReason: string | null;
  dataState: DataState;
}

export interface ProjectionFreshnessList {
  timestamp: string;
  items: ProjectionFreshness[];
}

/** Projectors that consume the V2 canonical event stream. */
export const KNOWN_PROJECTORS = [
  'v2-evidence',
  'v2-verification',
  'v2-disputes',
] as const;

export type KnownProjector = (typeof KNOWN_PROJECTORS)[number];
