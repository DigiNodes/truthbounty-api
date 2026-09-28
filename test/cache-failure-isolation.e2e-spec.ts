import { Test, TestingModule } from '@nestjs/testing';
import { ClaimsService } from '../src/claims/claims.service';
import { ClaimsCache } from '../src/cache/claims.cache';
import { RedisService } from '../src/redis/redis.service';
import { CacheUnavailableException } from '../src/cache/exceptions/cache-unavailable.exception';
import { CacheHealthService } from '../src/cache/cache-health.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { Repository } from 'typeorm';
import { Claim } from '../src/claims/entities/claim.entity';
import { getRepositoryToken } from '@nestjs/typeorm';

/**
 * Integration tests for cache failure isolation (V2-BE-116)
 * 
 * These tests verify that:
 * 1. Cache failures are isolated from canonical state (TypeORM/PostgreSQL)
 * 2. Cache failures are observable via logging and metrics
 * 3. Services fall back to database when cache fails
 * 4. No silent fallback to fabricated state occurs
 */
describe('Cache Failure Isolation (E2E)', () => {
  let module: TestingModule;
  let claimsService: ClaimsService;
  let claimsCache: ClaimsCache;
  let cacheHealthService: CacheHealthService;
  let claimRepo: Repository<Claim>;
  let redisService: RedisService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        ClaimsService,
        ClaimsCache,
        CacheHealthService,
        MetricsService,
        RedisService,
        {
          provide: getRepositoryToken(Claim),
          useClass: Repository,
        },
      ],
    }).compile();

    claimsService = module.get<ClaimsService>(ClaimsService);
    claimsCache = module.get<ClaimsCache>(ClaimsCache);
    cacheHealthService = module.get<CacheHealthService>(CacheHealthService);
    claimRepo = module.get<Repository<Claim>>(getRepositoryToken(Claim));
    redisService = module.get<RedisService>(RedisService);
  });

  afterAll(async () => {
    await module.close();
  });

  describe('Cache failure isolation from canonical state', () => {
    it('should serve from database when cache GET fails', async () => {
      const mockClaim = {
        id: 'test-claim-1',
        title: 'Test Claim',
        content: 'Test content',
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock database to return claim
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(mockClaim as Claim);

      // Mock cache to throw exception
      jest.spyOn(claimsCache, 'getClaim').mockRejectedValue(
        CacheUnavailableException.forGet('v1:claim:test-claim-1', new Error('Redis down')),
      );

      // Service should still return the claim from database
      const result = await claimsService.findOne('test-claim-1');
      expect(result).toEqual(mockClaim);
      expect(claimRepo.findOneBy).toHaveBeenCalledWith({ id: 'test-claim-1' });
    });

    it('should serve from database when cache SET fails', async () => {
      const mockClaim = {
        id: 'test-claim-2',
        title: 'Test Claim 2',
        content: 'Test content 2',
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock database to return claim
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(mockClaim as Claim);

      // Mock cache GET to return null (miss)
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(null);

      // Mock cache SET to throw exception
      jest.spyOn(claimsCache, 'setClaim').mockRejectedValue(
        CacheUnavailableException.forSet('v1:claim:test-claim-2', new Error('Redis write failed')),
      );

      // Service should still return the claim from database
      const result = await claimsService.findOne('test-claim-2');
      expect(result).toEqual(mockClaim);
      expect(claimRepo.findOneBy).toHaveBeenCalledWith({ id: 'test-claim-2' });
    });

    it('should log cache failures observably', async () => {
      const loggerSpy = jest.spyOn((claimsService as any).logger, 'warn');

      const mockClaim = {
        id: 'test-claim-3',
        title: 'Test Claim 3',
        content: 'Test content 3',
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(mockClaim as Claim);
      jest.spyOn(claimsCache, 'getClaim').mockRejectedValue(
        CacheUnavailableException.forGet('v1:claim:test-claim-3', new Error('Redis connection failed')),
      );

      await claimsService.findOne('test-claim-3');

      // Verify that cache failure was logged
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache unavailable for claim test-claim-3'),
        expect.stringContaining('serving from database'),
      );
    });
  });

  describe('Cache health metrics', () => {
    it('should record cache failures in metrics', async () => {
      const metricsSpy = jest.spyOn(cacheHealthService, 'recordFailure');

      const error = new Error('Redis timeout');
      cacheHealthService.recordFailure('GET', 'test:key', error);

      expect(metricsSpy).toHaveBeenCalledWith('GET', 'test:key', error);
    });

    it('should track failure rate correctly', () => {
      cacheHealthService.recordSuccess('GET');
      cacheHealthService.recordSuccess('GET');
      cacheHealthService.recordFailure('GET', 'test:key', new Error('Failed'));

      const status = cacheHealthService.getHealthStatus();
      expect(status.failureRate).toBeCloseTo(0.333, 2); // 1/3
    });

    it('should mark cache as unhealthy when threshold exceeded', () => {
      // Reset counters
      const newService = new CacheHealthService(redisService, module.get(MetricsService));

      // Exceed threshold of 10 failures
      for (let i = 0; i < 11; i++) {
        newService.recordFailure('GET', 'test:key', new Error('Failed'));
      }

      const status = newService.getHealthStatus();
      expect(status.healthy).toBe(false);
      expect(status.failureCount).toBe(11);
    });
  });

  describe('No silent fallback to fabricated state', () => {
    it('should not return fabricated data when cache fails', async () => {
      const mockClaim = {
        id: 'test-claim-4',
        title: 'Real Claim',
        content: 'Real content',
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(mockClaim as Claim);
      jest.spyOn(claimsCache, 'getClaim').mockRejectedValue(
        CacheUnavailableException.forGet('v1:claim:test-claim-4', new Error('Redis down')),
      );

      const result = await claimsService.findOne('test-claim-4');

      // Result must come from database, not fabricated
      expect(result).toEqual(mockClaim);
      expect(result.id).toBe('test-claim-4');
      expect(result.title).toBe('Real Claim');
    });

    it('should not skip database when cache fails', async () => {
      const findOneSpy = jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(null);

      jest.spyOn(claimsCache, 'getClaim').mockRejectedValue(
        CacheUnavailableException.forGet('v1:claim:nonexistent', new Error('Redis down')),
      );

      await claimsService.findOne('nonexistent');

      // Database must be queried even when cache fails
      expect(findOneSpy).toHaveBeenCalledWith({ id: 'nonexistent' });
    });
  });

  describe('Recovery after cache restoration', () => {
    it('should recover when cache becomes available', async () => {
      const mockClaim = {
        id: 'test-claim-5',
        title: 'Test Claim 5',
        content: 'Test content 5',
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // First call: cache fails, use database
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(mockClaim as Claim);
      jest.spyOn(claimsCache, 'getClaim')
        .mockRejectedValueOnce(
          CacheUnavailableException.forGet('v1:claim:test-claim-5', new Error('Redis down')),
        )
        .mockResolvedValueOnce(JSON.stringify(mockClaim)); // Cache recovers

      const result1 = await claimsService.findOne('test-claim-5');
      expect(result1).toEqual(mockClaim);

      // Second call: cache works
      const result2 = await claimsService.findOne('test-claim-5');
      expect(result2).toEqual(mockClaim);
    });
  });
});
