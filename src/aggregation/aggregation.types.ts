export enum VerificationVerdict {
  TRUE = 'TRUE',
  FALSE = 'FALSE',
}

export enum ClaimStatus {
  VERIFIED_TRUE = 'VERIFIED_TRUE',
  VERIFIED_FALSE = 'VERIFIED_FALSE',
  INCONCLUSIVE = 'INCONCLUSIVE',
}

export interface Verification {
  id: string;
  claimId: string;
  userId: string;
  verdict: VerificationVerdict;
  stakeAmount: number;          // integer or fixed-precision
  reputationWeight: number;     // normalized (e.g. 0–1 or 0–100)
  createdAt: Date;
}

export interface AggregationResult {
  claimId: string;
  status: ClaimStatus;
  confidence: number; // 0–100
  metadata: {
    trueWeight: number;
    falseWeight: number;
    verificationCount: number;
  };
}
