/**
 * UX-BE-004 (issue #595): protected operations, safe-retry and audit interfaces.
 *
 * These types are the wire contract for the privileged operations boards. All
 * operations here are **read or re-enqueue only**: nothing in this module may
 * mutate protocol state (claims, verification, disputes, settlement, rewards,
 * treasury, governance or pause). Chain contracts and canonical events remain
 * authoritative.
 */

/** Read/retry capability required for an operations request. */
export enum OperationalCapability {
  /** List queue items and read a single item's detail. */
  QUEUE_READ = 'OPERATIONS_QUEUE_READ',
  /** Read retry eligibility for a queue item. */
  RETRY_READ = 'OPERATIONS_RETRY_READ',
  /** Submit a retry for a queue item. */
  RETRY_SUBMIT = 'OPERATIONS_RETRY_SUBMIT',
  /** Look up an audit record by its stable audit identifier. */
  AUDIT_READ = 'OPERATIONS_AUDIT_READ',
}

/** Who is accountable for a queue item's resolution. */
export enum AuthoritySource {
  PROTOCOL_OPERATOR = 'PROTOCOL_OPERATOR',
  EMERGENCY_ADMIN = 'EMERGENCY_ADMIN',
  SYSTEM = 'SYSTEM',
}

/** Lifecycle status of an operational queue item. */
export enum QueueItemStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  QUARANTINED = 'quarantined',
}

/** Business impact of acting (or failing to act) on an item. */
export enum OperationalImpact {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

/** How likely a retry is to duplicate an existing effect. */
export enum DuplicationRisk {
  /** Safe: the item's idempotency key makes a re-run a no-op. */
  IDEMPOTENT = 'idempotent',
  /** Retry re-enqueues the same work with the same key. */
  IDEMPOTENT_REPLAY = 'idempotent_replay',
  /** Confirmed duplicate risk: do not retry without operator review. */
  POSSIBLE = 'possible',
}

/** Freshness of the data backing a queue item. */
export enum FreshnessState {
  FRESH = 'fresh',
  STALE = 'stale',
  UNKNOWN = 'unknown',
}

/** A single operational work item (immutable identifiers only). */
export interface OperationalQueueItem {
  /** Immutable work identifier. */
  id: string;
  /** Release the work belongs to. */
  releaseId: string;
  /** Capability that authorizes acting on this item. */
  capability: OperationalCapability;
  /** Accountable authority for the item. */
  authoritySource: AuthoritySource;
  /** ISO timestamp the accepting authority expires, or null when not time-bounded. */
  authorityExpiresAt: string | null;
  status: QueueItemStatus;
  impact: OperationalImpact;
  duplicationRisk: DuplicationRisk;
  freshness: FreshnessState;
  /** Attempts already made. */
  attempts: number;
  /** Maximum attempts the retry policy allows. */
  maxAttempts: number;
  /** Whether the item may be retried right now (fail-closed). */
  retryable: boolean;
  /** Monotonic version of the item; changes whenever state changes. */
  version: string;
  /** Last time the item changed. */
  updatedAt: string;
  /** Short, sanitized summary suitable for a queue list. */
  summary: string;
}

/** Queue summary returned to the boards. */
export interface OperationalQueueSummary {
  releaseId: string;
  generatedAt: string;
  total: number;
  countsByStatus: Record<QueueItemStatus, number>;
  items: OperationalQueueItem[];
}

/** Retry eligibility for one item. */
export interface RetryEligibility {
  id: string;
  eligible: boolean;
  /** Machine-readable reason when `eligible` is false. */
  reason: RetryDenialReason | null;
  attemptsRemaining: number;
  /** Opaque precondition token that must be echoed when submitting a retry. */
  preconditionToken: string;
}

/** Accepted result of a retry submission. */
export interface RetrySubmission {
  id: string;
  accepted: boolean;
  /** Stable audit identifier for the accepted request. */
  auditId: string;
  replayed: number;
  skipped: number;
  failed: number;
  detail: string | null;
}

/** Canonical reasons a retry may be refused. */
export enum RetryDenialReason {
  DENIED = 'denied',
  STALE_AUTHORITY = 'stale_authority',
  CONFLICT = 'conflict',
  ALREADY_COMPLETED = 'already_completed',
  UNSAFE_TO_RETRY = 'unsafe_to_retry',
  NOT_RETRYABLE = 'not_retryable',
  UNAVAILABLE = 'unavailable',
  RATE_LIMITED = 'rate_limited',
}

/** Sanitized audit record for a protected request. */
export interface OperationalAuditRecord {
  auditId: string;
  action: string;
  capability: OperationalCapability;
  authoritySource: AuthoritySource;
  actorId: string | null;
  outcome: 'accepted' | 'rejected';
  resultCode: string;
  subjectId: string | null;
  createdAt: string;
}

/** Outcome of a protected request, success or rejection. */
export interface ProtectedRequestOutcome<T> {
  accepted: boolean;
  auditId: string;
  data: T | null;
  reason: RetryDenialReason | null;
  message: string | null;
}
