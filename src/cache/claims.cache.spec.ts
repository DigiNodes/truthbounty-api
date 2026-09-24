import { ConfigService } from '@nestjs/config';
import { ClaimsCache } from './claims.cache';
import { RedisService } from '../redis/redis.service';

describe('ClaimsCache', () => {
  let cache: ClaimsCache;
  let redisService: jest.Mocked<
    Pick<RedisService, 'get' | 'set' | 'del' | 'getClient'>
  >;
  let mockSadd: jest.Mock;
  let mockSmembers: jest.Mock;
  let mockDel: jest.Mock;
  let mockSrem: jest.Mock;
  let mockExpire: jest.Mock;

  beforeEach(() => {
    mockSadd = jest.fn().mockResolvedValue(1);
    mockSmembers = jest.fn().mockResolvedValue(['v1:claim:123', 'v1:claims:latest']);
    mockDel = jest.fn().mockResolvedValue(2);
    mockSrem = jest.fn().mockResolvedValue(1);
    mockExpire = jest.fn().mockResolvedValue(true);

    const mockRedisClient = {
      sadd: mockSadd,
      smembers: mockSmembers,
      del: mockDel,
      srem: mockSrem,
      expire: mockExpire,
    };

    redisService = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'CACHE_CLAIMS_TTL') return 300;
        if (key === 'CACHE_VERSION') return 'v1';
        return null;
      }),
    } as unknown as ConfigService;

    cache = new ClaimsCache(
      redisService as unknown as RedisService,
      configService,
    );
  });

  describe('versioned keys', () => {
    it('uses versioned cache keys', async () => {
      const claim = { id: '123', title: 'Test Claim' };
      redisService.get.mockResolvedValue(JSON.stringify(claim));
      
      await cache.setClaim('123', claim);
      expect(redisService.set).toHaveBeenCalledWith(
        'v1:claim:123',
        JSON.stringify(claim),
        300,
      );

      const retrieved = await cache.getClaim('123');
      expect(retrieved).toEqual(claim);
      expect(redisService.get).toHaveBeenCalledWith('v1:claim:123');
    });

    it('generates correct versioned keys for user claims', async () => {
      const wallet = '0x1234567890123456789012345678901234567890';
      const claims = [{ id: '123', title: 'Test' }];
      
      await cache.setUserClaims(wallet, claims);
      expect(redisService.set).toHaveBeenCalledWith(
        'v1:claims:user:0x1234567890123456789012345678901234567890',
        JSON.stringify(claims),
        300,
      );
    });
  });

  describe('key tracking', () => {
    it('tracks cache keys in the index set', async () => {
      const claim = { id: '123', title: 'Test' };
      await cache.setClaim('123', claim);
      
      expect(mockSadd).toHaveBeenCalledWith(
        'claims:cache:keys',
        'v1:claim:123'
      );
      expect(mockExpire).toHaveBeenCalledWith('claims:cache:keys', 600); // 2*TTL
    });
  });

  describe('cache invalidation', () => {
    it('invalidates a specific claim and related lists', async () => {
      await cache.invalidateClaim('123', '0x1234567890');
      
      expect(redisService.del).toHaveBeenCalledTimes(3);
      expect(redisService.del).toHaveBeenCalledWith('v1:claim:123');
      expect(redisService.del).toHaveBeenCalledWith('v1:claims:latest');
      expect(redisService.del).toHaveBeenCalledWith('v1:claims:user:0x1234567890123456789012345678901234567890');
      expect(mockSrem).toHaveBeenCalled();
    });
  });

  describe('reorg handling', () => {
    it('invalidates ALL cache during a chain reorg', async () => {
      await cache.invalidateAllForReorg();
      
      expect(mockSmembers).toHaveBeenCalledWith('claims:cache:keys');
      expect(mockDel).toHaveBeenCalledWith('v1:claim:123', 'v1:claims:latest');
    });

    it('invalidates cache for a block range', async () => {
      await cache.invalidateBlockRange(1000, 1050);
      
      expect(mockSmembers).toHaveBeenCalled();
      expect(mockDel).toHaveBeenCalled();
    });
  });

  describe('projection updates', () => {
    it('invalidates specific affected claims', async () => {
      const invalidateSpy = jest.spyOn(cache, 'invalidateClaim');
      await cache.invalidateForProjectionUpdate(['123', '456']);
      
      expect(invalidateSpy).toHaveBeenCalledTimes(2);
    });

    it('invalidates all if no specific claims provided', async () => {
      const invalidateAllSpy = jest.spyOn(cache, 'invalidateAllForReorg');
      await cache.invalidateForProjectionUpdate();
      
      expect(invalidateAllSpy).toHaveBeenCalled();
    });
  });

  describe('graceful degradation', () => {
    it('returns null when Redis is unavailable', async () => {
      redisService.getClient.mockReturnValue(null);
      redisService.get.mockResolvedValue(null);
      
      const result = await cache.getClaim('123');
      expect(result).toBeNull();
    });

    it('handles JSON parsing errors gracefully', async () => {
      redisService.get.mockResolvedValue('invalid json');
      
      const result = await cache.getClaim('123');
      expect(result).toBeNull();
    });
  });
});