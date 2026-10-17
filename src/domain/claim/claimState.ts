/**
 * Canonical claim lifecycle states — V2-BE-017 (#614).
 *
 * This enum is the *only* claim state vocabulary used by projection
 * code. String values are stable and used in DB columns, contract
 * event logs, and REST responses.
 *
 * Unknown states MUST fail closed — never coerce to a "default" state.
 */
export enum ClaimState {
  /** First event emitted for a claim. */
  Submitted = 'SUBMITTED',
  /** A verifier has been assigned and is working. */
  Review = 'REVIEW',
  /** Verifier submitted a positive verdict (pre-finality). */
  Verified = 'VERIFIED',
  /** Verifier or moderator rejected the claim. */
  Rejected = 'REJECTED',
  /** A dispute has been raised. */
  Disputed = 'DISPUTED',
  /** Canonical finalized event observed on-chain. */
  Finalized = 'FINALIZED',
  /** Chain reorg rolled back a previously-finalized claim. */
  Reorged = 'REORGED',
}

/**
 * Exhaustive, contract-legal transitions. Anything not listed here
 * is rejected by `isTransitionAllowed`.
 */
const ALLOWED_TRANSITIONS: Record<ClaimState, readonly ClaimState[]> = {
  [ClaimState.Submitted]: [ClaimState.Review, ClaimState.Rejected],
  [ClaimState.Review]: [
    // The contract can settle directly from UNDER_VERIFICATION (SETTLED
    // event) — Verified is optional, not required. Keep both edges.
    ClaimState.Verified,
    ClaimState.Finalized,
    ClaimState.Rejected,
    ClaimState.Disputed,
  ],
  [ClaimState.Verified]: [ClaimState.Finalized, ClaimState.Disputed],
  [ClaimState.Rejected]: [ClaimState.Finalized],
  [ClaimState.Disputed]: [ClaimState.Finalized, ClaimState.Rejected],
  [ClaimState.Finalized]: [ClaimState.Reorged],
  [ClaimState.Reorged]: [],
};

export function isTransitionAllowed(from: ClaimState, to: ClaimState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Fail-closed parser for untrusted input (DB rows, contract logs, HTTP). */
export function parseClaimState(raw: unknown): ClaimState {
  if (typeof raw === 'string') {
    const match = (Object.values(ClaimState) as string[]).includes(raw)
      ? (raw as ClaimState)
      : undefined;
    if (match) return match;
  }
  throw new Error(
    'Unknown claim state: ' + JSON.stringify(raw) + ' — fail closed.',
  );
}
