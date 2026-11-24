import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  PUBLIC_STATUS_SCENARIOS,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-status.scenarios';
import { HealthService } from '../health.service';
import { FinalizedCursorService } from '../../indexer/finalized-cursor/finalized-cursor.service';
import { PublicStatusController } from './public-status.controller';
import {
  PUBLIC_STATUS_OPTIONS,
  PublicStatusOptions,
} from './public-status.options';
import { projectPublicStatus } from './public-status.projector';
import { PublicStatusRateLimitGuard } from './public-status-rate-limit.guard';
import { PublicStatusService } from './public-status.service';

const options: PublicStatusOptions = {
  cacheTtlSeconds: 15,
  staleAfterSeconds: 120,
  webHealthUrl: null,
  webProbeTimeoutMs: 100,
  rateLimit: 3,
  rateLimitWindowSeconds: 60,
};

describe('GET /status/public (UX-BE-001)', () => {
  let app: INestApplication;
  const healthService = {
    getDependencyHealth: jest.fn(),
  };

  beforeEach(async () => {
    healthService.getDependencyHealth.mockReset();
    // This suite runs on the real clock, so the probe must be fresh.
    healthService.getDependencyHealth.mockResolvedValue({
      ...PUBLIC_STATUS_SCENARIOS.databaseUnavailable.dependencies,
      checkedAt: new Date().toISOString(),
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicStatusController],
      providers: [
        PublicStatusService,
        PublicStatusRateLimitGuard,
        { provide: HealthService, useValue: healthService },
        { provide: PUBLIC_STATUS_OPTIONS, useValue: options },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it('returns the sanitized projection with cache and schema headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/status/public')
      .expect(200);
    expect(res.headers['cache-control']).toMatch(/^public, max-age=\d+$/);
    expect(res.headers['x-public-status-schema']).toBe('public-status.v1');
    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(
      res.body.components.find((c: any) => c.id === 'database').state,
    ).toBe('unavailable');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('db.internal');
    expect(text).not.toContain('failureReason');
  });

  it('serves repeated requests from cache without re-probing', async () => {
    const server = app.getHttpServer();
    await request(server).get('/status/public').expect(200);
    await request(server).get('/status/public').expect(200);
    expect(healthService.getDependencyHealth).toHaveBeenCalledTimes(1);
  });

  it('rate limits per client with 429 and Retry-After', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++)
      await request(server).get('/status/public').expect(200);
    const res = await request(server).get('/status/public').expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });
});

describe('PublicStatusService', () => {
  const baseInputs = PUBLIC_STATUS_SCENARIOS.allOperational;

  function makeService(
    overrides: {
      health?: Partial<HealthService>;
      cursor?: Partial<FinalizedCursorService> | undefined;
      now?: () => Date;
      opts?: Partial<PublicStatusOptions>;
    } = {},
  ) {
    const health = {
      getDependencyHealth: jest.fn().mockResolvedValue(baseInputs.dependencies),
      ...overrides.health,
    } as unknown as HealthService;
    const cursor =
      'cursor' in overrides
        ? (overrides.cursor as FinalizedCursorService | undefined)
        : ({
            getConfiguredStatus: jest.fn().mockResolvedValue(baseInputs.cursor),
            getConfiguredBinding: jest.fn().mockReturnValue(baseInputs.release),
          } as unknown as FinalizedCursorService);
    return new PublicStatusService(
      health,
      cursor,
      { ...options, ...overrides.opts },
      overrides.now ?? (() => baseInputs.now),
    );
  }

  it('matches the projector output for the same inputs', async () => {
    const { body } = await makeService().getSnapshot();
    const expected = projectPublicStatus(
      { ...baseInputs, web: null },
      { staleAfterSeconds: 120, cacheTtlSeconds: 15 },
    );
    expect(body).toEqual(expected);
    expect(SCENARIO_POLICY.cacheTtlSeconds).toBe(15);
  });

  it('degrades a failing source to unknown instead of healthy', async () => {
    const service = makeService({
      health: {
        getDependencyHealth: jest
          .fn()
          .mockRejectedValue(new Error('postgres://x:y@h')),
      },
      cursor: {
        getConfiguredStatus: jest.fn().mockRejectedValue(new Error('rpc down')),
        getConfiguredBinding: jest.fn().mockReturnValue(baseInputs.release),
      } as unknown as FinalizedCursorService,
    });
    const { body } = await service.getSnapshot();
    for (const id of ['database', 'evidence_gateway', 'rpc', 'indexer']) {
      expect(body.components.find((c) => c.id === id)!.state).toBe('unknown');
    }
    expect(body.overall).toBe('unknown');
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('reports unknown chain data when no cursor service is available', async () => {
    const { body } = await makeService({ cursor: undefined }).getSnapshot();
    expect(body.chain.state).toBe('unknown');
    expect(body.release.state).toBe('unknown');
  });

  it('re-projects after the cache TTL expires and counts down max-age', async () => {
    let now = baseInputs.now.getTime();
    const getDependencyHealth = jest
      .fn()
      .mockResolvedValue(baseInputs.dependencies);
    const service = makeService({
      health: { getDependencyHealth },
      now: () => new Date(now),
    });
    expect((await service.getSnapshot()).maxAgeSeconds).toBe(15);
    now += 10_000;
    expect((await service.getSnapshot()).maxAgeSeconds).toBe(5);
    expect(getDependencyHealth).toHaveBeenCalledTimes(1);
    now += 6_000;
    await service.getSnapshot();
    expect(getDependencyHealth).toHaveBeenCalledTimes(2);
  });

  it('probes the web frontend when configured without exposing the URL', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ status: 200 } as Response);
    try {
      const { body } = await makeService({
        opts: { webHealthUrl: 'https://web.internal.truthbounty/healthz' },
      }).getSnapshot();
      const web = body.components.find((c) => c.id === 'web')!;
      expect(web.state).toBe('operational');
      expect(web.observation.source).toBe('web_probe');
      expect(JSON.stringify(body)).not.toContain('web.internal');

      fetchSpy.mockRejectedValueOnce(new Error('ENOTFOUND'));
      const down = await makeService({
        opts: { webHealthUrl: 'https://web.internal.truthbounty/healthz' },
      }).getSnapshot();
      expect(down.body.components.find((c) => c.id === 'web')!.state).toBe(
        'unavailable',
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
