export enum ClaimState {
  Submitted = 'SUBMITTED',
  UnderVerification = 'UNDER_VERIFICATION',
  Disputed = 'DISPUTED',
  Settled = 'SETTLED',
  Rejected = 'REJECTED',
  Expired = 'EXPIRED',
}

// Only transitions the contract can actually emit are legal here.
const ALLOWED_TRANSITIONS: Record<ClaimState, ClaimState[]> = {
  [ClaimState.Submitted]: [ClaimState.UnderVerification, ClaimState.Expired],
  [ClaimState.UnderVerification]: [ClaimState.Disputed, ClaimState.Settled, ClaimState.Rejected, ClaimState.Expired],
  [ClaimState.Disputed]: [ClaimState.Settled, ClaimState.Rejected],
  [ClaimState.Settled]: [],
  [ClaimState.Rejected]: [],
  [ClaimState.Expired]: [],
};

export function isTransitionAllowed(from: ClaimState, to: ClaimState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
