import { JobsService } from './jobs.service';

describe('JobsService', () => {
  let service: JobsService;
  let redisService: any;
  let stakeRepo: any;
  let walletRepo: any;
  let claimRepo: any;
  let userRepo: any;
  let claimsCache: any;
  let aggregationService: any;
  let mockQueryBuilder: any;

  beforeEach(() => {
    redisService = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    stakeRepo = {
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    walletRepo = {
      findOneBy: jest.fn(),
    };

    userRepo = {
      findOneBy: jest.fn(),
    };

    claimsCache = {
      invalidateClaim: jest.fn(),
    };

    aggregationService = {
      aggregate: jest.fn(),
    };

    mockQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    claimRepo = {
      find: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    service = new JobsService(
      redisService,
      stakeRepo,
      walletRepo,
      claimRepo,
      userRepo,
      claimsCache,
      aggregationService,
    );
  });

  it('should skip concurrent claim updates when another worker finalizes first', async () => {
    const claim = { id: 'claim-1', finalized: false };
    claimRepo.find.mockResolvedValue([claim]);
    stakeRepo.find.mockResolvedValue([{ id: 'stake-1', walletAddress: 'wallet-1', amount: '100', updatedAt: new Date() }]);
    walletRepo.findOneBy.mockResolvedValue({ userId: 'user-1', address: 'wallet-1' });
    userRepo.findOneBy.mockResolvedValue({ id: 'user-1', reputation: 40 });
    aggregationService.aggregate.mockReturnValue({ confidence: 75, status: 'VERIFIED_TRUE' });
    mockQueryBuilder.execute.mockResolvedValue({ affected: 0 });

    await service['computeScores']();

    expect(claimRepo.createQueryBuilder).toHaveBeenCalled();
    expect(mockQueryBuilder.set).toHaveBeenCalledWith({ confidenceScore: 0.75, finalized: true, resolvedVerdict: true });
    expect(claimsCache.invalidateClaim).not.toHaveBeenCalled();
  });

  it('should update claim confidence and invalidate cache when aggregation succeeds', async () => {
    const claim = { id: 'claim-2', finalized: false };
    claimRepo.find.mockResolvedValue([claim]);
    stakeRepo.find.mockResolvedValue([{ id: 'stake-2', walletAddress: 'wallet-2', amount: '100', updatedAt: new Date() }]);
    walletRepo.findOneBy.mockResolvedValue({ userId: 'user-2', address: 'wallet-2' });
    userRepo.findOneBy.mockResolvedValue({ id: 'user-2', reputation: 40 });
    aggregationService.aggregate.mockReturnValue({ confidence: 75, status: 'VERIFIED_TRUE' });
    mockQueryBuilder.execute.mockResolvedValue({ affected: 1 });

    await service['computeScores']();

    expect(claimRepo.createQueryBuilder).toHaveBeenCalled();
    expect(mockQueryBuilder.set).toHaveBeenCalledWith({ confidenceScore: 0.75, finalized: true, resolvedVerdict: true });
    expect(claimsCache.invalidateClaim).toHaveBeenCalledWith(claim.id);
  });
});
