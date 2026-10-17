import { ClaimState } from '../../domain/claim/claimState';

/**
 * Public-facing projection "status" buckets used by the search/detail
 * endpoints. Every canonical ClaimState maps into exactly one bucket.
 *
 * Exhaustiveness is enforced by `Record<ClaimState, ...>` — the compiler
 * rejects any future ClaimState addition that isn't mapped here.
 */
export type ProjectionStatus =
  | 'open'
  | 'in_review'
  | 'verified'
  | 'rejected'
  | 'disputed'
  | 'finalized'
  | 'reorged';

export const CLAIM_STATE_TO_STATUS: Readonly<
  Record<ClaimState, ProjectionStatus>
> = {
  [ClaimState.Submitted]: 'open',
  [ClaimState.Review]: 'in_review',
  [ClaimState.Verified]: 'verified',
  [ClaimState.Rejected]: 'rejected',
  [ClaimState.Disputed]: 'disputed',
  [ClaimState.Finalized]: 'finalized',
  [ClaimState.Reorged]: 'reorged',
};

/**
 * Reverse index: status -> list of canonical states. Exhaustive and
 * stable-ordered so filter serialization is deterministic.
 */
export const STATUS_TO_CLAIM_STATES: Readonly<
  Record<ProjectionStatus, readonly ClaimState[]>
> = (() => {
  const acc: Record<ProjectionStatus, ClaimState[]> = {
    open: [],
    in_review: [],
    verified: [],
    rejected: [],
    disputed: [],
    finalized: [],
    reorged: [],
  };
  for (const state of Object.values(ClaimState)) {
    acc[CLAIM_STATE_TO_STATUS[state]].push(state);
  }
  return acc;
})();

/**
 * Fail-closed status parser. Rejects unknown statuses rather than
 * silently ignoring them (which would widen the search result set).
 */
export function parseProjectionStatus(raw: unknown): ProjectionStatus {
  const candidates: ProjectionStatus[] = [
    'open',
    'in_review',
    'verified',
    'rejected',
    'disputed',
    'finalized',
    'reorged',
  ];
  if (typeof raw === 'string' && (candidates as string[]).includes(raw)) {
    return raw as ProjectionStatus;
  }
  throw new Error(
    'Unknown projection status: ' + JSON.stringify(raw) + ' — fail closed.',
  );
}
