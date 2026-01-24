import { ClaimResolutionService } from "./claim-resolution.service";

describe('Confidence Scoring', () => {
  const service = new ClaimResolutionService(null as any);

  it('returns high confidence for strong consensus', () => {
    const score = service.computeConfidenceScore({
      trueWeight: 180,
      falseWeight: 20,
    });

    expect(score).toBeGreaterThan(0.7);
  });

  it('returns low confidence for split votes', () => {
    const score = service.computeConfidenceScore({
      trueWeight: 110,
      falseWeight: 90,
    });

    expect(score).toBeLessThan(0.3);
  });

  it('returns null for low participation', () => {
    const score = service.computeConfidenceScore({
      trueWeight: 30,
      falseWeight: 20,
    });

    expect(score).toBeNull();
  });

  it('returns zero for tie', () => {
    const score = service.computeConfidenceScore({
      trueWeight: 100,
      falseWeight: 100,
    });

    expect(score).toBe(0);
  });
});
