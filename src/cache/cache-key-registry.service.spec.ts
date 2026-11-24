import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { CacheKeyDefinition, CacheKeyRegistryService } from './cache-key-registry.service';

/** Test double that simulates Redis SCAN over an in-memory key set. */
class TestRegistry extends CacheKeyRegistryService {
  constructor(redis: RedisService, private readonly stored: Set<string>) {
    super({} as ConfigService, redis);
  }

  protected async findKeysByPattern(pattern: string): Promise<string[]> {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return [...this.stored].filter((k) => re.test(k)).sort();
  }
}

describe('CacheKeyRegistryService', () => {
  let stored: Set<string>;
  let del: jest.Mock;
  let registry: TestRegistry;

  const base = (): CacheKeyDefinition => ({
    key: 'test:{chainId}:{id}',
    version: 1,
    description: 'test',
    ttlSeconds: 60,
    scopes: ['chain'],
    tags: ['test'],
    invalidationTriggers: [{ event: 'claim.updated', pattern: 'test:*' }],
  });

  beforeEach(async () => {
    stored = new Set();
    del = jest.fn(async (key: string) => {
      stored.delete(key);
      return true;
    });
    registry = new TestRegistry({ del } as unknown as RedisService, stored);
    await registry.onModuleInit();
  });

  describe('schema validation', () => {
    it('registers every default key with explicit known triggers at startup', () => {
      const keys = registry.listKeys();
      expect(keys.length).toBeGreaterThan(0);
      for (const def of keys) {
        expect(def.invalidationTriggers.length).toBeGreaterThan(0);
      }
    });

    it('rejects a definition with missing triggers', () => {
      const def = { ...base(), invalidationTriggers: [] };
      expect(() => registry.registerKey(def)).toThrow(/invalidation trigger/);
    });

    it('rejects a definition with absent triggers property', () => {
      const { invalidationTriggers: _omit, ...rest } = base();
      expect(() => registry.registerKey(rest as CacheKeyDefinition)).toThrow(/invalidation trigger/);
    });

    it('rejects unknown trigger events', () => {
      const def = base();
      (def.invalidationTriggers[0] as { event: string }).event = 'claim.exploded';
      expect(() => registry.registerKey(def)).toThrow(/Unknown invalidation trigger/);
    });

    it('rejects duplicate keys (namespace collision)', () => {
      registry.registerKey(base());
      expect(() => registry.registerKey(base())).toThrow(/Duplicate/);
    });

    it('rejects chain-scoped keys without a {chainId} namespace', () => {
      expect(() => registry.registerKey({ ...base(), key: 'test:{id}' })).toThrow(/chainId/);
    });
  });

  describe('invalidation', () => {
    it('returns Redis deletion success for a specific key', async () => {
      stored.add('cache:v1:wallet:claims:detail:claim-1');

      await expect(
        registry.invalidateKey('claims:detail:{claimId}', {
          claimId: 'claim-1',
        }),
      ).resolves.toBe(true);
      del.mockResolvedValueOnce(false);
      await expect(
        registry.invalidateKey('claims:detail:{claimId}', {
          claimId: 'claim-1',
        }),
      ).resolves.toBe(false);
    });

    it('rejects unknown runtime events (untrusted input)', async () => {
      await expect(registry.invalidateByTrigger('nope')).rejects.toThrow(/Unknown invalidation event/);
    });

    it('evicts keys on a matching domain event', async () => {
      stored.add('claims:detail:1');
      stored.add('disputes:detail:1');
      const result = await registry.invalidateByTrigger('claim.updated');
      expect(result.invalidatedKeys).toContain('claims:detail:1');
      expect(stored.has('disputes:detail:1')).toBe(true);
    });

    it('evicts only the affected chain on reorg (multi-chain isolation)', async () => {
      stored.add('blockchain:block:1:100');
      stored.add('blockchain:block:10:100');
      stored.add('leaderboard:1:score:day:1:10');
      stored.add('leaderboard:10:score:day:1:10');
      await registry.invalidateByTrigger('blockchain.reorg', { chainId: '1' });
      expect(stored.has('blockchain:block:1:100')).toBe(false);
      expect(stored.has('leaderboard:1:score:day:1:10')).toBe(false);
      expect(stored.has('leaderboard:10:score:day:1:10')).toBe(true);
    });

    it('evicts stale chain projections on release rollover deterministically', async () => {
      stored.add('analytics:metrics:1:tvl:1h');
      stored.add('claims:list:1:open:1:10');
      stored.add('identity:profile:0xabc');
      const first = await registry.invalidateByTrigger('release.rollover');
      expect(first.invalidatedKeys).toEqual(['analytics:metrics:1:tvl:1h', 'claims:list:1:open:1:10']);
      expect(stored.has('identity:profile:0xabc')).toBe(true);
      const second = await registry.invalidateByTrigger('release.rollover');
      expect(second.invalidatedCount).toBe(0);
    });
  });
});
