/**
 * Result contract for the Projection Readiness Gate (V2-BE-100).
 *
 * The gate answers exactly one question: may this projected read model be
 * served as a reproduction of canonical Optimism/EVM state right now?
 *
 * Two properties are load-bearing and are part of the contract, not an
 * implementation detail:
 *
 *  1. The evaluation is total: every possible outcome is representable, and
 *     "unknown" is never collapsed into "ready". A thrown error, an
 *     unreadable dependency, or an unrecognized projector all resolve to
 *     `ready: false` with an explicit reason.
 *  2. The result is self-describing: it carries the evidence behind the
 *     verdict (cursor, canonical head, pending/quarantined counts, per-check
 *     detail) so an operator can act on a failure without reading logs or
 *     reaching for a debugger.
 */

/** Status of a single invariant check inside one evaluation. */
export enum ProjectionReadinessCheckStatus {
  PASS = 'pass',
  FAIL = 'fail',
}

/**
 * Machine-readable reason a projection is not ready. Each value maps to one
 * documented failure mode and one recovery procedure; see
 * docs/PROJECTION_READINESS_GATE.md.
 */
export enum ProjectionReadinessReason {
  /** The gate itself could not complete. Fail closed: unknown is not ready. */
  EVALUATION_ERROR = 'evaluation_error',
  /** The projector name is not in the V2 projector registry. */
  UNKNOWN_PROJECTOR = 'unknown_projector',
  /** Canonical events exist for this projector but no cursor has ever been written. */
  CURSOR_MISSING = 'cursor_missing',
  /** The cursor is behind the newest canonical event the projector must consume. */
  BACKLOG = 'backlog',
  /** The cursor is ahead of the canonical event stream (impossible/truncated history). */
  CURSOR_AHEAD_OF_STREAM = 'cursor_ahead_of_stream',
  /** Undecodable logs exist for an approved protocol contract: the projection is knowingly incomplete. */
  QUARANTINE_BACKLOG = 'quarantine_backlog',
}

/** One invariant check, reported whether it passed or failed. */
export interface ProjectionReadinessCheck {
  name: string;
  status: ProjectionReadinessCheckStatus;
  detail: string;
}

/** Chain-native ordering coordinate: (blockNumber, logIndex). */
export interface ProjectionOrderKey {
  blockNumber: string;
  logIndex: number;
}

/** The gate's verdict for a single projector. */
export interface ProjectionReadiness {
  projector: string;
  ready: boolean;
  status: 'ready' | 'not_ready';
  evaluatedAt: string;
  /** The projector's consumed-through coordinate, or null if it has never run. */
  cursor: ProjectionOrderKey | null;
  /** Newest canonical event coordinate this projector must consume, or null if none exist. */
  canonicalHead: ProjectionOrderKey | null;
  /** Canonical events strictly after the cursor: the projection's backlog. */
  pendingEvents: number;
  /** Quarantined logs belonging to approved protocol contracts. */
  quarantinedProtocolLogs: number;
  /** Threshold in force for {@link quarantinedProtocolLogs} during this evaluation. */
  quarantineThreshold: number;
  reasons: ProjectionReadinessReason[];
  checks: ProjectionReadinessCheck[];
}

/** Aggregate verdict across every registered projector. */
export interface ProjectionReadinessReport {
  ready: boolean;
  status: 'ready' | 'not_ready';
  evaluatedAt: string;
  projectors: ProjectionReadiness[];
}
