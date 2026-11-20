import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletRateLimiterService } from './wallet-rate-limiter.service';
import { RedisService } from '../redis/redis.service';
import { Request } from 'express';

describe('WalletRateLimiterService (Cost-Aware Distributed Rate-Limit Budgets)', () => {
  let service: WalletRateLimiterService;
  let redisServiceMock: jest.Mocked<RedisService>;
  let configServiceMock: jest.Mocked<ConfigService>;

  const mockRedisStorage = new Map<
    string,
    { count: number; blocked: boolean; pttl: number }
  >();

  beforeEach(async () => {
    mockRedisStorage.clear();

    redisServiceMock = {
      isHealthy: jest.fn().mockResolvedValue(true),
      eval: jest
        .fn()
        .mockImplementation(
          async (script, numKeys, key, windowMs, scaledCost) => {
            const current =
              (mockRedisStorage.get(key)?.count || 0) + Number(scaledCost);
            mockRedisStorage.set(key, {
              count: current,
              blocked: false,
              pttl: windowMs,
            });
            return [current, windowMs];
          },
        ),
      exists: jest.fn().mockImplementation(async (key) => {
        const record = mockRedisStorage.get(key);
        return record?.blocked ? 1 : 0;
      }),
      pttl: jest.fn().mockImplementation(async (key) => {
        const record = mockRedisStorage.get(key);
        return record?.pttl || 60000;
      }),
      set: jest.fn().mockImplementation(async (key, value, ttl) => {
        mockRedisStorage.set(key, {
          count: 999,
          blocked: true,
          pttl: (ttl || 60) * 1000,
        });
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
        {
          provide: 'REQUEST',
          useValue: {
            path: '/api/claims',
            method: 'GET',
            ip: '127.0.0.1',
            headers: {},
          },
        },
      ],
    }).compile();

    service = module.get<WalletRateLimiterService>(WalletRateLimiterService);
  });

  async function createServiceWithConfig(
    values: Record<string, unknown> = {},
  ): Promise<WalletRateLimiterService> {
    const config = {
      get: jest.fn().mockImplementation((key: string, defaultVal: unknown) => {
        if (key in values) return values[key];
        if (key === 'RATE_LIMIT_DEFAULT_LIMIT') return 10;
        if (key === 'RATE_LIMIT_DEFAULT_TTL') return 60;
        return defaultVal;
      }),
    } as unknown as ConfigService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletRateLimiterService,
        { provide: RedisService, useValue: redisServiceMock },
        { provide: ConfigService, useValue: config },
        {
          provide: 'REQUEST',
          useValue: {
            path: '/api/claims',
            method: 'GET',
            ip: '127.0.0.1',
            headers: {},
          },
        },
      ],
    }).compile();

    return module.get<WalletRateLimiterService>(WalletRateLimiterService);
  }

  function lastRateLimitKey(): string {
    return redisServiceMock.eval.mock.calls.at(-1)![2] as string;
  }

  it('1. Burst and sustained rate limiting: allows requests within budget and blocks when exceeded', async () => {
    const req = {
      path: '/api/claims',
      method: 'GET',
      ip: '192.168.1.1',
      headers: {},
    } as unknown as Request;

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
    const req = {
      path: '/api/claims',
      method: 'GET',
      ip: '10.0.0.1',
      headers: {},
    } as unknown as Request;

    // Fire 5 concurrent requests with cost 2
    const promises = Array.from({ length: 5 }, () =>
      service.checkRateLimit(req),
    );
    const results = await Promise.all(promises);

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBeGreaterThan(0);
    expect(redisServiceMock.eval).toHaveBeenCalledTimes(5);
  });

  it('3. Redis outage (Fail Closed): security-sensitive limits fail closed when Redis is unhealthy', async () => {
    redisServiceMock.isHealthy.mockResolvedValueOnce(false);
    const req = {
      path: '/auth/login',
      method: 'POST',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;

    const result = await service.checkRateLimit(req);
    expect(result.allowed).toBe(false);
    expect(result.isBlocked).toBe(true);
  });

  it('rejects malformed Redis counter replies and uses valid Lua arguments', async () => {
    const req = {
      path: '/auth/login',
      method: 'POST',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;
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

  it('5. Anonymous wallet-header rotation shares a single IP-scoped bucket', async () => {
    const base = { path: '/api/claims', method: 'GET', ip: '198.51.100.20' };
    const variants = [
      {},
      { 'x-wallet-address': '0x1111111111111111111111111111111111111111' },
      { 'x-wallet': '0x2222222222222222222222222222222222222222' },
      { 'x-api-key': 'raw-header-key' },
      {
        'x-wallet-address':
          '0x3333333333333333333333333333333333333333:ip:9.9.9.9',
      },
    ];

    const results: boolean[] = [];
    for (const headers of variants) {
      const result = await service.checkRateLimit({
        ...base,
        headers,
      } as unknown as Request);
      results.push(result.allowed);
    }

    expect(results).toEqual([true, true, true, true, true]);
    const keys = redisServiceMock.eval.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain('ratelimit::ip:198.51.100.20:path:api:claims');
  });

  it('6. Expensive query proportional cost: expensive endpoints (admin=20x, ai=10x) consume proportional cost', async () => {
    const reqAdmin = {
      path: '/admin/settings',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;
    const reqHealth = {
      path: '/health',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;

    // Admin endpoint cost is 20 (scaled 200). Default limit 10 requests -> 100 units.
    // 1 admin request consumes 200 units (> 100 max budget), instantly blocking!
    const resAdmin = await service.checkRateLimit(reqAdmin);
    expect(resAdmin.allowed).toBe(false);

    // Health endpoint cost is 0.1 (scaled 1). Allowed multiple times.
    const resHealth = await service.checkRateLimit(reqHealth);
    expect(resHealth.allowed).toBe(true);
  });

  it('7. Recovery test: traffic is allowed again after recovery / block reset', async () => {
    const req = {
      path: '/api/claims',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request;

    // Simulate recovery by resetting mock storage
    mockRedisStorage.clear();
    redisServiceMock.exists.mockResolvedValueOnce(0);

    const result = await service.checkRateLimit(req);
    expect(result.allowed).toBe(true);
  });

  it('anonymous requests without a wallet header share the same IP-scoped bucket', async () => {
    const first = {
      path: '/api/claims',
      method: 'GET',
      ip: '203.0.113.10',
      headers: {},
    } as unknown as Request;
    const second = {
      path: '/api/claims',
      method: 'GET',
      ip: '203.0.113.10',
      headers: {},
    } as unknown as Request;

    await service.checkRateLimit(first);
    await service.checkRateLimit(second);

    const keys = redisServiceMock.eval.mock.calls.map((call) => call[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain('ratelimit::ip:203.0.113.10:path:api:claims');
  });

  it('uses a wallet-scoped bucket only for a verified JWT principal', async () => {
    const anonymous = {
      path: '/api/claims',
      method: 'GET',
      ip: '203.0.113.5',
      headers: {},
    } as unknown as Request;
    await service.checkRateLimit(anonymous);
    const anonymousKey = lastRateLimitKey();

    mockRedisStorage.clear();
    redisServiceMock.eval.mockClear();

    const authenticated = {
      path: '/api/claims',
      method: 'GET',
      ip: '203.0.113.5',
      headers: {},
      user: {
        address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        userId: 'user-1',
      },
    } as unknown as Request;
    const result = await service.checkRateLimit(authenticated);

    expect(result.allowed).toBe(true);
    expect(lastRateLimitKey()).toContain(
      'ratelimit::wallet:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:path:api:claims',
    );
    expect(lastRateLimitKey()).not.toBe(anonymousKey);
  });

  it('does not let forged or malformed wallet headers move a verified principal bucket', async () => {
    const principal = {
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'user-2',
    };
    const headerVariants = [
      { 'x-wallet-address': '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { 'x-wallet': '0xcccccccccccccccccccccccccccccccccccccccc' },
      { 'x-wallet-address': '0xdeadbeef:ip:9.9.9.9' },
      {
        'x-api-key': 'raw-header-key',
        'x-wallet': '0xdddddddddddddddddddddddddddddddddddddddd',
      },
    ];

    for (const headers of headerVariants) {
      await service.checkRateLimit({
        path: '/api/claims',
        method: 'GET',
        ip: '203.0.113.7',
        headers,
        user: principal,
      } as unknown as Request);
    }

    const keys = redisServiceMock.eval.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(
      'ratelimit::wallet:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:path:api:claims',
    );
  });

  it('ignores spoofed X-Forwarded-For values and attributes anonymous traffic to the trusted socket peer', async () => {
    const limiter = await createServiceWithConfig({
      TRUSTED_PROXIES: ['10.0.0.1'],
      MAX_PROXY_HOPS: 2,
    });

    const proxiedRequests = [
      { forwardedFor: '203.0.113.100, 10.0.0.1', ip: '203.0.113.100' },
      { forwardedFor: '198.51.100.44, 10.0.0.1', ip: '198.51.100.44' },
      { forwardedFor: '192.0.2.77, 8.8.8.8, 10.0.0.1', ip: '192.0.2.77' },
    ];

    for (const { forwardedFor, ip } of proxiedRequests) {
      await limiter.checkRateLimit({
        path: '/api/claims',
        method: 'GET',
        ip,
        socket: { remoteAddress: '10.0.0.1' },
        headers: { 'x-forwarded-for': forwardedFor },
      } as unknown as Request);
    }

    const keys = redisServiceMock.eval.mock.calls.map((call) => call[2]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain('ratelimit::ip:10.0.0.1:path:api:claims');

    await limiter.checkRateLimit({
      path: '/api/claims',
      method: 'GET',
      ip: '9.9.9.9',
      socket: { remoteAddress: '203.0.113.9' },
      headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' },
    } as unknown as Request);

    expect(lastRateLimitKey()).toContain(
      'ratelimit::ip:203.0.113.9:path:api:claims',
    );
  });

  it('enforces the same distributed limit across replicas under concurrent requests', async () => {
    const replicaA = await createServiceWithConfig();
    const replicaB = await createServiceWithConfig();
    const req = {
      path: '/api/claims',
      method: 'GET',
      ip: '192.0.2.10',
      headers: {},
    } as unknown as Request;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? replicaA : replicaB).checkRateLimit(req),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(redisServiceMock.eval).toHaveBeenCalledTimes(10);
    expect(
      new Set(redisServiceMock.eval.mock.calls.map((call) => call[2])).size,
    ).toBe(1);
  });

  it('preserves endpoint cost multipliers and rate-limit response headers', async () => {
    const adminResult = await service.checkRateLimit({
      path: '/admin/settings',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request);

    expect(adminResult.allowed).toBe(false);
    expect(redisServiceMock.eval.mock.calls[0][4]).toBe(200);
    expect(service.getRateLimitHeaders(adminResult)).toEqual({
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.ceil(adminResult.resetTime / 1000)),
      'X-RateLimit-Blocked': 'true',
      'Retry-After': String(Math.ceil((adminResult.retryAfterMs || 0) / 1000)),
    });

    const healthResult = await service.checkRateLimit({
      path: '/health',
      method: 'GET',
      ip: '127.0.0.1',
      headers: {},
    } as unknown as Request);

    expect(healthResult.allowed).toBe(true);
    expect(redisServiceMock.eval.mock.calls[1][4]).toBe(1);
    expect(service.getRateLimitHeaders(healthResult)).toEqual({
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '9.9',
      'X-RateLimit-Reset': String(Math.ceil(healthResult.resetTime / 1000)),
      'X-RateLimit-Blocked': 'false',
    });
  });
});
