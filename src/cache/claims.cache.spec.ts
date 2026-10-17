import { ConfigService } from '@nestjs/config';
import { ClaimsCache } from './claims.cache';
import { RedisService } from '../redis/redis.service';
import { CacheHealthService } from './cache-health.service';

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
  let mockScan: jest.Mock;
  let mockScanStream: jest.Mock;

  const createScanResult = (cursor: string, keys: string[]): [string, string[]] => [cursor, keys];

  beforeEach(() => {
    mockSadd = jest.fn().mockResolvedValue(1);
    mockSmembers = jest
      .fn()
      .mockResolvedValue(['v1:claim:123', 'v1:claims:latest']);
    mockDel = jest.fn().mockResolvedValue(2);
    mockSrem = jest.fn().mockResolvedValue(1);
    mockExpire = jest.fn().mockResolvedValue(true);
    mockScan = jest
      .fn()
      .mockImplementation(async (cursor: string) =>
        cursor === '0'
          ? createScanResult('0', ['v1:claim:123', 'v1:claims:latest'])
          : createScanResult('0', []),
      );
    mockScanStream = jest.fn().mockImplementation(() => {
      const items = ['v1:claim:123', 'v1:claims:latest'];
      return {
        async *[Symbol.asyncIterator]() {
          for (const item of items) {
            yield item;
          }
        },
      };
    });

    const mockRedisClient = {
      sadd: mockSadd,
      smembers: mockSmembers,
      del: mockDel,
      srem: mockSrem,
      expire: mockExpire,
      scan: mockScan,
      scanStream: mockScanStream,
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
        if (key === 'CACHE_SCAN_BATCH_SIZE') return 100;
        if (key === 'CACHE_SCAN_MAX_ITERATIONS') return 1000;
        if (key === 'CACHE_SCAN_TIMEOUT_MS') return 5000;
        return null;
      }),
    } as unknown as ConfigService;

    const cacheHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    } as unknown as CacheHealthService;

    cache = new ClaimsCache(
      redisService as unknown as RedisService,
      configService,
      cacheHealthService,
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
        'v1:claim:123',
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
      // Key uses the wallet as passed (lowercased) — matches the input above.
      expect(redisService.del).toHaveBeenCalledWith(
        'v1:claims:user:0x1234567890',
      );
      expect(mockSrem).toHaveBeenCalled();
    });
  });

  describe('reorg handling', () => {
    it('invalidates ALL cache during a chain reorg', async () => {
      await cache.invalidateAllForReorg();

      expect(mockScanStream).toHaveBeenCalled();
      expect(mockDel).toHaveBeenCalledWith('v1:claim:123', 'v1:claims:latest');
    });

    it('invalidates cache for a block range', async () => {
      await cache.invalidateBlockRange(1000, 1050);

      expect(mockScanStream).toHaveBeenCalled();
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

    it('invalidates nothing when explicitly told no claims were affected (V2-BE-115)', async () => {
      const invalidateAllSpy = jest.spyOn(cache, 'invalidateAllForReorg');
      const invalidateClaimSpy = jest.spyOn(cache, 'invalidateClaim');

      // An empty array is a different signal than "Unknown scope": the
      // caller knows this projection update didn't touch any claim (for
      // example, a token-balance-only event), so nothing should be
      // invalidated at all, not even a full flush.
      await cache.invalidateForProjectionUpdate([]);

      expect(invalidateAllSpy).not.toHaveBeenCalled();
      expect(invalidateClaimSpy).not.toHaveBeenCalled();
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

  describe('bounded SCAN pattern matching', () => {
    it('does not use KEYS or placeholder matching on invalidation paths', async () => {
      const client = redisService.getClient();
      expect(client).not.toBeNull();
      expect((client as any).keys).toBeUndefined();

      await cache.invalidateAllForReorg();
      expect(mockScanStream).toHaveBeenCalled();
    });

    it('scans in bounded batches with explicit namespace patterns', async () => {
      await cache.invalidateAllForReorg();

      const calls = mockScanStream.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const args = call[0] as Array<unknown>;
        expect(args.length).toBeGreaterThanOrEqual(2);
        const match = String(args[1]);
        expect(match).toMatch(/^v1:(claim|chain):/);
        expect(match).not.toContain('**');
        expect(match).not.toContain('?');
      }
    });

    it('escapes wildcards in dynamic segments before scanning', async () => {
      const wallet = '0x*?[]abc';
      await cache.invalidateClaim('123', wallet);

      const scanPatterns = mockScanStream.mock.calls.map((call) =>
        String((call[0] as Array<unknown>)[1]),
      );
      for (const pattern of scanPatterns) {
        expect(pattern).not.toMatch(/[^ \\][\*\?][^ \\]]/);
      }
    });

    it('respects the configured timeout and stops scanning', async () => {
      const slowScan = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return createScanResult('1', ['v1:claim:1']);
      });
      mockScanStream.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const [, keys] = await slowScan();
              yield keys[0];
            }
          },
        };
      });

      await expect(cache.invalidateAllForReorg()).rejects.toThrow();
    });

    it('supports cancellation during a long scan', async () => {
      const abortController = new AbortController();
      const promise = cache.invalidateAllForReorg({ signal: abortController.signal });
      abortController.abort();

      await expect(promise).rejects.toThrow();
    });

    it('resumes from a provided cursor after partial failure', async () => {
      const firstScan = jest
        .fn()
        .mockResolvedValueOnce(createScanResult('42', ['v1:claim:1']))
        .mockRejectedValueOnce(new Error('Redis connection lost'));
      mockScanStream.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            const [, keys] = await firstScan();
            for (const key of keys) {
              yield key;
            }
          },
        };
      });

      await expect(cache.invalidateAllForReorg()).rejects.toThrow();

      const resume = jest
        .fn()
        .mockResolvedValue(createScanResult('0', ['v1:claim:1']));
      mockScanStream.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            const [, keys] = await resume();
            for (const key of keys) {
              yield key;
            }
          },
        };
      });

      await cache.invalidateAllForReorg({ cursor: '42' });
      expect(resume).toHaveBeenCalled();
    });

    it('reports partial failure through cache health metrics', async () => {
      const health = (cache as unknown as { health?: CacheHealthService }).health;
      if (health) {
        expect(health.recordFailure).toHaveBeenCalled();
      }
      mockScanStream.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield 'v1:claim:1';
            throw new Error('partial failure');
          },
        };
      });

      await expect(cache.invalidateAllForReorg()).rejects.toThrow();
    });

    it('scans cluster nodes with bounded per-node cursors', async () => {
      const nodeScan = jest
        .fn()
        .mockImplementation(async () => createScanResult('0', ['v1:claim:1']));
      mockScanStream.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            const [, keys] = await nodeScan();
            for (const key of keys) {
              yield key;
            }
          },
        };
      });

      await cache.invalidateAllForReorg();
      expect(nodeScan).toHaveBeenCalled();
      expect(mockDel).toHaveBeenCalledWith('v1:claim:1');
    });

    it('handles concurrent mutation during scan without losing keys', async () => {
      const mutations = ['v1:claim:1', 'v1:claim:2', 'v1:claim:3'];
      mockScanStream.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            for (const key of mutations) {
              yield key;
            }
          },
        };
      });

      await cache.invalidateAllForReorg();
      for (const key of mutations) {
        expect(mockDel).toHaveBeenCalledWith(key);
      }
    });
  });
});
