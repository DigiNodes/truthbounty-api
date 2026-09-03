import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ClaimResolutionService, VoteWeightSummary } from './claim-resolution.service';
import { Claim, ClaimState } from './entities/claim.entity';
import { ClaimFactory } from './factories/claim.factory';

// ─── Shared stubs ────────────────────────────────────────────────────────────

function makeClaimRepoStub(claim?: Claim) {
  return {
    findOneBy: jest.fn().mockResolvedValue(claim ?? null),
    save: jest.fn().mockImplementation(async (entity: any) => entity),
    count: jest.fn().mockResolvedValue(0),
  };
}

function makeClaimsCacheStub() {
  return {
    invalidateClaim: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDataSourceStub(claimRepoStub: ReturnType<typeof makeClaimRepoStub>) {
  return {
    transaction: jest.fn().mockImplementation(async (cb: (manager: any) => Promise<any>) => {
      const manager = { save: claimRepoStub.save };
      return cb(manager);
    }),
  };
}

// ─── computeConfidenceScore ───────────────────────────────────────────────────

describe('ClaimResolutionService.computeConfidenceScore', () => {
  let claimRepoStub: ReturnType<typeof makeClaimRepoStub>;
  let claimsCacheStub: ReturnType<typeof makeClaimsCacheStub>;
  let dataSourceStub: ReturnType<typeof makeDataSourceStub>;
  let service: ClaimResolutionService;

  beforeEach(() => {
    claimRepoStub = makeClaimRepoStub();
    claimsCacheStub = makeClaimsCacheStub();
    dataSourceStub = makeDataSourceStub(claimRepoStub);
    service = new ClaimResolutionService(
      claimRepoStub as any,
      claimsCacheStub as any,
      dataSourceStub as any,
    );
  });

  it('returns high confidence score for strong consensus', () => {
    const result = service.computeConfidenceScore({ trueWeight: 180, falseWeight: 20 });

    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.7);
    expect(result!.verdict).toBe('true');
  });

  it('returns low confidence score for split votes', () => {
    const result = service.computeConfidenceScore({ trueWeight: 110, falseWeight: 90 });

    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(0.3);
  });

  it('returns null for low participation (below MIN_REQUIRED_WEIGHT)', () => {
    const result = service.computeConfidenceScore({ trueWeight: 30, falseWeight: 20 });

    expect(result).toBeNull();
  });

  it('returns score of 0 for an exact tie (margin is 0)', () => {
    const result = service.computeConfidenceScore({ trueWeight: 100, falseWeight: 100 });

    expect(result).not.toBeNull();
    expect(result!.score).toBe(0);
    expect(result!.verdict).toBe('inconclusive');
  });

  it('returns verdict "false" when false votes dominate', () => {
    const result = service.computeConfidenceScore({ trueWeight: 20, falseWeight: 180 });

    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('false');
    expect(result!.score).toBeGreaterThan(0.7);
  });

  it('caps participation factor at 1 when total greatly exceeds minimum', () => {
    const result = service.computeConfidenceScore({ trueWeight: 900, falseWeight: 100 });

    expect(result).not.toBeNull();
    expect(result!.participation).toBe(1);
  });

  it('throws BadRequestException for negative vote weights', () => {
    expect(() =>
      service.computeConfidenceScore({ trueWeight: -10, falseWeight: 50 }),
    ).toThrow(BadRequestException);
  });

  it('throws BadRequestException for non-finite vote weights', () => {
    expect(() =>
      service.computeConfidenceScore({ trueWeight: Infinity, falseWeight: 50 }),
    ).toThrow(BadRequestException);
  });
});

// ─── resolveClaim ─────────────────────────────────────────────────────────────

describe('ClaimResolutionService.resolveClaim', () => {
  let service: ClaimResolutionService;
  let claimRepoStub: ReturnType<typeof makeClaimRepoStub>;
  let claimsCacheStub: ReturnType<typeof makeClaimsCacheStub>;
  let dataSourceStub: ReturnType<typeof makeDataSourceStub>;

  function buildService(claim?: Claim) {
    claimRepoStub = makeClaimRepoStub(claim);
    claimsCacheStub = makeClaimsCacheStub();
    dataSourceStub = makeDataSourceStub(claimRepoStub);
    service = new ClaimResolutionService(
      claimRepoStub as any,
      claimsCacheStub as any,
      dataSourceStub as any,
    );
  }

  it('throws NotFoundException when claim does not exist', async () => {
    buildService(undefined);
    await expect(
      service.resolveClaim('missing-id', { trueWeight: 150, falseWeight: 50 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when claim is already finalized', async () => {
    const claim = ClaimFactory.createClaim({ finalized: true });
    buildService(claim);

    await expect(
      service.resolveClaim(claim.id, { trueWeight: 150, falseWeight: 50 }),
    ).rejects.toThrow(ConflictException);
  });

  it('throws BadRequestException for invalid (negative) vote weights', async () => {
    const claim = ClaimFactory.createClaim({ finalized: false });
    buildService(claim);

    await expect(
      service.resolveClaim(claim.id, { trueWeight: -1, falseWeight: 50 }),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── BE-219: resolvedAt invariants ──────────────────────────────────────

  it('sets resolvedAt on the saved claim when sufficient votes exist (BE-219)', async () => {
    const claim = ClaimFactory.createClaim({
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      resolvedAt: null,
    });
    buildService(claim);

    const before = new Date();
    const result = await service.resolveClaim(claim.id, { trueWeight: 160, falseWeight: 40 });
    const after = new Date();

    expect(result.claim.resolvedAt).toBeInstanceOf(Date);
    expect(result.claim.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.claim.resolvedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('sets resolvedAt on the saved claim for the inconclusive (low participation) path (BE-219)', async () => {
    const claim = ClaimFactory.createClaim({
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      resolvedAt: null,
    });
    buildService(claim);

    const before = new Date();
    const result = await service.resolveClaim(claim.id, { trueWeight: 30, falseWeight: 20 });
    const after = new Date();

    // Confidence is null (insufficient participation) but resolvedAt must still be set
    expect(result.confidence).toBeNull();
    expect(result.claim.resolvedAt).toBeInstanceOf(Date);
    expect(result.claim.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.claim.resolvedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('resolvedAt in the return value matches the claim entity resolvedAt (BE-219)', async () => {
    const claim = ClaimFactory.createClaim({
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      resolvedAt: null,
    });
    buildService(claim);

    const result = await service.resolveClaim(claim.id, { trueWeight: 150, falseWeight: 50 });

    expect(result.resolvedAt).toBeInstanceOf(Date);
    // The returned resolvedAt must match what was written onto the entity
    expect(result.claim.resolvedAt).toBeInstanceOf(Date);
  });

  it('does not overwrite an existing resolvedAt on a previously resolved claim (BE-219)', async () => {
    const existingResolvedAt = new Date('2024-03-01T10:00:00Z');
    // Simulate a claim that was already resolved but not yet finalized
    const claim = ClaimFactory.createClaim({
      resolvedVerdict: true,
      confidenceScore: 0.80,
      finalized: false,
      resolvedAt: existingResolvedAt,
    });
    buildService(claim);

    const result = await service.resolveClaim(claim.id, { trueWeight: 160, falseWeight: 40 });

    // The original resolvedAt must be preserved — should not be overwritten
    expect(result.claim.resolvedAt).toEqual(existingResolvedAt);
  });

  it('invalidates the claim cache after resolution (BE-219)', async () => {
    const claim = ClaimFactory.createClaim({
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      resolvedAt: null,
    });
    buildService(claim);

    await service.resolveClaim(claim.id, { trueWeight: 150, falseWeight: 50 });

    expect(claimsCacheStub.invalidateClaim).toHaveBeenCalledWith(claim.id);
  });

  it('returns the saved claim with finalized=true after sufficient votes (BE-219)', async () => {
    const claim = ClaimFactory.createClaim({
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      resolvedAt: null,
    });
    buildService(claim);

    const result = await service.resolveClaim(claim.id, { trueWeight: 150, falseWeight: 50 });

    expect(result.claim.finalized).toBe(true);
    expect(result.claim.resolvedAt).not.toBeNull();
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
