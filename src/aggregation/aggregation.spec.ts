import { AggregationService } from './aggregation.service';
import {
  VerificationVerdict,
  ClaimStatus,
  Verification,
} from './aggregation.types';

describe('AggregationService', () => {
  const service = new AggregationService();

  const base = {
    claimId: 'claim-1',
    createdAt: new Date(),
  };

  it('resolves simple weighted majority', () => {
    const verifications: Verification[] = [
      { ...base, id: '1', userId: 'a', verdict: VerificationVerdict.TRUE, stakeAmount: 10, reputationWeight: 1 },
      { ...base, id: '2', userId: 'b', verdict: VerificationVerdict.FALSE, stakeAmount: 5, reputationWeight: 1 },
    ];

    const result = service.aggregate('claim-1', verifications);

    expect(result.status).toBe(ClaimStatus.VERIFIED_TRUE);
    expect(result.confidence).toBeGreaterThan(50);
  });

  it('allows reputation-weighted minority to win', () => {
    const verifications: Verification[] = [
      { ...base, id: '1', userId: 'a', verdict: VerificationVerdict.FALSE, stakeAmount: 20, reputationWeight: 0.2 },
      { ...base, id: '2', userId: 'b', verdict: VerificationVerdict.TRUE, stakeAmount: 5, reputationWeight: 2 },
    ];

    const result = service.aggregate('claim-1', verifications);

    expect(result.status).toBe(ClaimStatus.VERIFIED_TRUE);
  });

  it('handles tie as inconclusive', () => {
    const verifications: Verification[] = [
      { ...base, id: '1', userId: 'a', verdict: VerificationVerdict.TRUE, stakeAmount: 10, reputationWeight: 1 },
      { ...base, id: '2', userId: 'b', verdict: VerificationVerdict.FALSE, stakeAmount: 10, reputationWeight: 1 },
    ];

    const result = service.aggregate('claim-1', verifications);

    expect(result.status).toBe(ClaimStatus.INCONCLUSIVE);
  });

  it('handles no verifications', () => {
    const result = service.aggregate('claim-1', []);

    expect(result.status).toBe(ClaimStatus.INCONCLUSIVE);
    expect(result.confidence).toBe(0);
  });
});
