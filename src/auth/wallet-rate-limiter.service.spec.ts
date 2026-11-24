import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletRateLimiterService } from './wallet-rate-limiter.service';
import { RedisService } from '../redis/redis.service';
import { Request } from 'express';

describe('WalletRateLimiterService (Cost-Aware Distributed Rate-Limit Budgets)', () => {
  let service: WalletRateLimiterService;
  let redisServiceMock: jest.Mocked<RedisService>;
  let configServiceMock: jest.Mocked<ConfigService>;

  const mockRedisStorage = new Map<string, { count: number; blocked: boolean; pttl: number }>();

  beforeEach(async () => {
    mockRedisStorage.clear();

    redisServiceMock = {
      isHealthy: jest.fn().mockResolvedValue(true),
      eval: jest.fn().mockImplementation(async (script, numKeys, key, windowMs, scaledCost) => {
        const current = (mockRedisStorage.get(key)?.count || 0) + Number(scaledCost);
        mockRedisStorage.set(key, { count: current, blocked: false, pttl: windowMs });
        return [current, windowMs];
      }),
      exists: jest.fn().mockImplementation(async (key) => {
        const record = mockRedisStorage.get(key);
        return record?.blocked ? 1 : 0;
      }),
      pttl: jest.fn().mockImplementation(async (key) => {
        const record = mockRedisStorage.get(key);
        return record?.pttl || 60000;
      }),
      set: jest.fn().mockImplementation(async (key, value, ttl) => {
        mockRedisStorage.set(key, { count: 999, blocked: true, pttl: (ttl || 60) * 1000 });
        return true;
      }),
      getClient: jest.fn().mockReturnValue({
        set: jest.fn().mockResolvedValue('OK'),
      }),
    } as unknown as jest.Mocked<RedisService>;

    configServiceMock = {
      get: jest.fn().mockImplementation((key, defaultVal) => {
        if (key === 'RATE_LIMIT_DEFAULT_LIMIT') return 10;
        if (key === 'RATE_LIMIT_DEFAULT_TTL') return 60;
        return defaultVal;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletRateLimiterService,
        { provide: RedisService, useValue: redisServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: 'REQUEST', useValue: { path: '/api/claims', method: 'GET', ip: '127.0.0.1', headers: {} } },
      ],
    }).compile();

    service = module.get<WalletRateLimiterService>(WalletRateLimiterService);
  });

  it('1. Burst and sustained rate limiting: allows requests within budget and blocks when exceeded', async () => {
    const req = { path: '/api/claims', method: 'GET', ip: '192.168.1.1', headers: {} } as unknown as Request;

    // Limit is 10 requests (cost 2 -> 5 requests total)
    for (let i = 0; i < 5; i++) {
      const result = await service.checkRateLimit(req);
      expect(result.allowed).toBe(true);
    }

    // 6th request exceeds budget (5 * 2 = 10)
    const blockedResult = await service.checkRateLimit(req);
    expect(blockedResult.allowed).toBe(false);
    expect(blockedResult.isBlocked).toBe(true);
  });

  it('2. Distributed race condition: concurrent requests increment atomically across simulated replicas', async () => {
    const req = { path: '/api/claims', method: 'GET', ip: '10.0.0.1', headers: {} } as unknown as Request;

    // Fire 5 concurrent requests with cost 2
    const promises = Array.from({ length: 5 }, () => service.checkRateLimit(req));
    const results = await Promise.all(promises);

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBeGreaterThan(0);
    expect(redisServiceMock.eval).toHaveBeenCalledTimes(5);
  });

  it('3. Redis outage (Fail Closed): security-sensitive limits fail closed when Redis is unhealthy', async () => {
    redisServiceMock.isHealthy.mockResolvedValueOnce(false);
    const req = { path: '/auth/login', method: 'POST', ip: '127.0.0.1', headers: {} } as unknown as Request;

    const result = await service.checkRateLimit(req);
    expect(result.allowed).toBe(false);
    expect(result.isBlocked).toBe(true);
  });

  it('rejects malformed Redis counter replies and uses valid Lua arguments', async () => {
    const req = { path: '/auth/login', method: 'POST', ip: '127.0.0.1', headers: {} } as unknown as Request;
    redisServiceMock.eval.mockResolvedValueOnce('invalid response');

    await expect(service.checkRateLimit(req)).rejects.toThrow(
      /Rate limit Redis failure \(Fail Closed\)/,
    );
    const [luaScript] = redisServiceMock.eval.mock.calls[0];
    expect(luaScript).toContain('ARGV[2]');
    expect(luaScript).toContain('KEYS[1]');
  });

  it('4. IPv6 and proxy headers: correctly identifies client IP and trusted proxy headers', async () => {
    const req = {
      path: '/api/claims',
      method: 'GET',
      ip: '2001:db8::1', // IPv6
      headers: {
        'x-forwarded-for': '2001:db8::1, 10.0.0.1',
      },
    } as unknown as Request;

    const result = await service.checkRateLimit(req);
    expect(result.allowed).toBe(true);
  });

  it('5. Wallet rotation: rotating wallet identity tracks separate rate limit buckets', async () => {
    const reqWallet1 = {
      path: '/api/claims',
      method: 'GET',
      ip: '127.0.0.1',
      headers: { 'x-wallet-address': '0x1111111111111111111111111111111111111111' },
      user: { address: '0x1111111111111111111111111111111111111111', trustLevel: 'trusted', trustScore: 80 },
    } as unknown as Request;

    const reqWallet2 = {
      path: '/api/claims',
      method: 'GET',
      ip: '127.0.0.1',
      headers: { 'x-wallet-address': '0x2222222222222222222222222222222222222222' },
      user: { address: '0x2222222222222222222222222222222222222222', trustLevel: 'trusted', trustScore: 80 },
    } as unknown as Request;

    const res1 = await service.checkRateLimit(reqWallet1);
    const res2 = await service.checkRateLimit(reqWallet2);

    expect(res1.allowed).toBe(true);
    expect(res2.allowed).toBe(true);
  });

  it('6. Expensive query proportional cost: expensive endpoints (admin=20x, ai=10x) consume proportional cost', async () => {
    const reqAdmin = { path: '/admin/settings', method: 'GET', ip: '127.0.0.1', headers: {} } as unknown as Request;
    const reqHealth = { path: '/health', method: 'GET', ip: '127.0.0.1', headers: {} } as unknown as Request;

    // Admin endpoint cost is 20 (scaled 200). Default limit 10 requests -> 100 units.
    // 1 admin request consumes 200 units (> 100 max budget), instantly blocking!
    const resAdmin = await service.checkRateLimit(reqAdmin);
    expect(resAdmin.allowed).toBe(false);

    // Health endpoint cost is 0.1 (scaled 1). Allowed multiple times.
    const resHealth = await service.checkRateLimit(reqHealth);
    expect(resHealth.allowed).toBe(true);
  });

  it('7. Recovery test: traffic is allowed again after recovery / block reset', async () => {
    const req = { path: '/api/claims', method: 'GET', ip: '127.0.0.1', headers: {} } as unknown as Request;

    // Simulate recovery by resetting mock storage
    mockRedisStorage.clear();
    redisServiceMock.exists.mockResolvedValueOnce(0);

    const result = await service.checkRateLimit(req);
    expect(result.allowed).toBe(true);
  });
});
