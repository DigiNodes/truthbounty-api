import { ClaimState } from './claimState';

/**
 * Canonical claim lifecycle events emitted by the on-chain "truth bounty"
 * contract. These are the source of truth for the claim lifecycle read model.
 *
 * Each event maps 1:1 to a ClaimState transition. Only transitions the
 * contract can actually emit are legal — the transition legality is enforced
 * by `isTransitionAllowed` in `claimState.ts`.
 */
export enum ClaimLifecycleEventType {
  SUBMITTED = 'SUBMITTED',
  UNDER_VERIFICATION = 'UNDER_VERIFICATION',
  DISPUTED = 'DISPUTED',
  SETTLED = 'SETTLED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

/**
 * The on-chain ClaimState a given lifecycle event transitions the claim *into*
 * via the contract's state machine.
 */
export const EVENT_TYPE_TO_STATE: Record<ClaimLifecycleEventType, ClaimState> =
  {
    [ClaimLifecycleEventType.SUBMITTED]: ClaimState.Submitted,
    [ClaimLifecycleEventType.UNDER_VERIFICATION]: ClaimState.UnderVerification,
    [ClaimLifecycleEventType.DISPUTED]: ClaimState.Disputed,
    [ClaimLifecycleEventType.SETTLED]: ClaimState.Settled,
    [ClaimLifecycleEventType.REJECTED]: ClaimState.Rejected,
    [ClaimLifecycleEventType.EXPIRED]: ClaimState.Expired,
  };

/**
 * A single observed, canonical claim lifecycle event. Consumers (e.g. the
 * claim projector, reconciliations, analytics) should depend on this shape
 * rather than raw chain logs.
 */
export interface CanonicalClaimEvent {
  /** Canonical lifecycle event type */
  type: ClaimLifecycleEventType;
  /** On-chain claim id (token id / struct key) */
  claimId: string;
  /** Sequential index of the event within the claim's history */
  eventIndex: number;
  /** Index of the log within its transaction (0 when not applicable) */
  logIndex?: number;
  /** Originating chain, e.g. 'optimism', for multi-chain support */
  chainId: string;
  /** Block height the event was observed at */
  blockNumber: number;
  /** Transaction hash the event was emitted in */
  txHash: string;
  /** Emitted by this account (submitter, challenger, oracle, ...) */
  actor?: string | null;
  /**
   * Arbitrary contract-encoded payload (verdict, amount, reason hash, ...).
   * Kept opaque so new fields don't break consumers.
   */
  payload?: Record<string, unknown> | null;
  /** Block timestamp of emission */
  blockTimestamp: Date;
}
