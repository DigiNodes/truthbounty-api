import { ClaimResolutionService } from "./claim-resolution.service";

describe('Confidence Scoring', () => {
  const service = new ClaimResolutionService(null as any, null as any);

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

// ------------------------------------------------------------------ //
// resolveClaim — resolvedAt invariant (BE-219)                         //
// ------------------------------------------------------------------ //
describe('ClaimResolutionService.resolveClaim — resolvedAt invariant (BE-219)', () => {
  function makeService() {
    // Minimal mock repo and cache
    const mockClaim = {
      id: 'claim-001',
      resolvedVerdict: null,
      resolvedAt: null,
      confidenceScore: null,
      finalized: false,
    };

    const mockRepo: any = {
      findOneBy: jest.fn().mockResolvedValue({ ...mockClaim }),
      save: jest.fn().mockImplementation(async (c: any) => ({ ...c })),
    };

    const mockCache: any = {
      invalidateClaim: jest.fn().mockResolvedValue(undefined),
    };

    return { service: new ClaimResolutionService(mockRepo, mockCache), mockRepo, mockCache };
  }

  it('sets resolvedAt to a non-null Date when a claim is resolved (BE-219)', async () => {
    const { service } = makeService();
    const before = Date.now();

    const result = await service.resolveClaim('claim-001', { trueWeight: 150, falseWeight: 50 });

    const after = Date.now();
    expect(result.resolvedAt).not.toBeNull();
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect((result.resolvedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((result.resolvedAt as Date).getTime()).toBeLessThanOrEqual(after);
  });

  it('sets resolvedAt and resolvedVerdict atomically (BE-219)', async () => {
    const { service, mockRepo } = makeService();
    const savedArgs: any[] = [];
    mockRepo.save.mockImplementation(async (c: any) => {
      savedArgs.push({ resolvedVerdict: c.resolvedVerdict, resolvedAt: c.resolvedAt });
      return c;
    });

    await service.resolveClaim('claim-001', { trueWeight: 150, falseWeight: 50 });

    expect(savedArgs).toHaveLength(1);
    expect(savedArgs[0].resolvedVerdict).not.toBeNull();
    expect(savedArgs[0].resolvedAt).not.toBeNull();
  });

  it('sets finalized = true along with resolvedAt (BE-219)', async () => {
    const { service } = makeService();
    const result = await service.resolveClaim('claim-001', { trueWeight: 150, falseWeight: 50 });
    expect(result.finalized).toBe(true);
    expect(result.resolvedAt).not.toBeNull();
  });

  it('throws when claim is not found', async () => {
    const { service, mockRepo } = makeService();
    mockRepo.findOneBy.mockResolvedValue(null);
    await expect(service.resolveClaim('bad-id', { trueWeight: 100, falseWeight: 50 })).rejects.toThrow('Claim not found');
  });

  it('resolvedVerdict=true when trueWeight > falseWeight', async () => {
    const { service } = makeService();
    const result = await service.resolveClaim('claim-001', { trueWeight: 150, falseWeight: 50 });
    expect(result.resolvedVerdict).toBe(true);
  });

  it('resolvedVerdict=false when falseWeight > trueWeight', async () => {
    const { service } = makeService();
    const result = await service.resolveClaim('claim-001', { trueWeight: 50, falseWeight: 150 });
    expect(result.resolvedVerdict).toBe(false);
  });
});
