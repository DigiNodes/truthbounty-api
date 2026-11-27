import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TransactionRunner } from '../database/transaction.runner';
import { RedisService } from '../redis/redis.service';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlagAuditEvent } from './entities/feature-flag-audit-event.entity';
import { FeatureFlagVersion } from './entities/feature-flag-version.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import { FeatureFlagConfiguration } from './feature-flags.types';
import { FeatureFlagsMetricsService } from './metrics/feature-flag.metrics';

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;
  let flagRepo: Record<string, jest.Mock>;
  let versionRepo: Record<string, jest.Mock>;
  let auditRepo: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let metrics: Record<string, jest.Mock>;
  let order: string[];

  const makeFlag = (overrides: Record<string, unknown> = {}): FeatureFlag =>
    ({
      id: 'flag-1',
      key: 'new-ui',
      type: 'boolean',
      enabled: false,
      rolloutPercentage: 0,
      rules: null,
      environment: 'production',
      description: 'current',
      isPermanent: false,
      metadata: null,
      expiresAt: null,
      version: 3,
      rolledBackFromVersion: null,
      changeReason: null,
      createdBy: 'creator',
      ...overrides,
    }) as unknown as FeatureFlag;

  const configuration = (
    overrides: Partial<FeatureFlagConfiguration> = {},
  ): FeatureFlagConfiguration => ({
    key: 'new-ui',
    type: 'percentage',
    enabled: true,
    rolloutPercentage: 42,
    rules: { userIds: ['user-1'] },
    environment: 'staging',
    description: 'historical',
    isPermanent: true,
    metadata: { source: 'history' },
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  });

  const snapshotFor = (
    config: FeatureFlagConfiguration,
    version: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: `snapshot-${version}`,
    flagId: 'flag-1',
    version,
    ...config,
    contentHash: (service as any).computeContentHash(config),
    previousHash: null,
    sourceVersion: null,
    validationStatus: 'valid',
    ...overrides,
  });

  beforeEach(async () => {
    order = [];
    flagRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn(),
    };
    versionRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      insert: jest.fn().mockResolvedValue({}),
    };
    auditRepo = {
      insert: jest.fn().mockResolvedValue({}),
      find: jest.fn(),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockImplementation(async () => {
        order.push('cache');
        return true;
      }),
    };
    metrics = {
      recordActiveFlags: jest.fn(),
      recordDisabledFlags: jest.fn(),
      incrementConfigChanges: jest.fn(),
      recordCacheHitRatio: jest.fn(),
      observeRefreshLatency: jest.fn(),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === FeatureFlag) return flagRepo;
        if (entity === FeatureFlagVersion) return versionRepo;
        if (entity === FeatureFlagAuditEvent) return auditRepo;
        throw new Error('Unexpected repository request');
      }),
    };
    const transactionRunner = {
      run: jest.fn(async (callback: (manager: unknown) => Promise<unknown>) => {
        const result = await callback(manager);
        order.push('commit');
        return result;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagsService,
        { provide: getRepositoryToken(FeatureFlag), useValue: flagRepo },
        {
          provide: getRepositoryToken(FeatureFlagVersion),
          useValue: versionRepo,
        },
        {
          provide: getRepositoryToken(FeatureFlagAuditEvent),
          useValue: auditRepo,
        },
        { provide: RedisService, useValue: redis },
        { provide: FeatureFlagsMetricsService, useValue: metrics },
        { provide: TransactionRunner, useValue: transactionRunner },
      ],
    }).compile();

    service = module.get<FeatureFlagsService>(FeatureFlagsService);
  });

  it('should evaluate boolean flag', async () => {
    flagRepo.findOne.mockResolvedValue(makeFlag({ enabled: true }));

    const result = await service.evaluate('new-ui');
    expect(result.enabled).toBe(true);
  });

  it('should evaluate disabled flag', async () => {
    flagRepo.findOne.mockResolvedValue(makeFlag({ enabled: false }));

    const result = await service.evaluate('new-ui');
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('should evaluate user flag', async () => {
    flagRepo.findOne.mockResolvedValue(
      makeFlag({
        type: 'user',
        enabled: true,
        rules: { userIds: ['user-123'] },
      }),
    );

    const included = await service.evaluate('beta-feature', {
      userId: 'user-123',
    });
    expect(included.enabled).toBe(true);

    const excluded = await service.evaluate('beta-feature', {
      userId: 'user-999',
    });
    expect(excluded.enabled).toBe(false);
  });

  it('should evaluate role flag', async () => {
    flagRepo.findOne.mockResolvedValue(
      makeFlag({ type: 'role', enabled: true, rules: { roles: ['admin'] } }),
    );

    const included = await service.evaluate('admin-tool', { roles: ['admin'] });
    expect(included.enabled).toBe(true);

    const excluded = await service.evaluate('admin-tool', { roles: ['user'] });
    expect(excluded.enabled).toBe(false);
  });

  it('restores every configuration field from the requested snapshot', async () => {
    const target = configuration();
    const current = makeFlag();
    const updated = makeFlag({
      ...target,
      version: 4,
      rolledBackFromVersion: 2,
      changeReason: 'restore incident',
      createdBy: 'admin-1',
    });

    flagRepo.findOne
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(updated);
    versionRepo.findOne
      .mockResolvedValueOnce(snapshotFor(target, 2))
      .mockResolvedValueOnce(
        snapshotFor(configuration({ type: 'boolean', enabled: false }), 3),
      );

    const result = await service.rollback(
      'flag-1',
      2,
      'admin-1',
      'restore incident',
    );

    expect(result.version).toBe(4);
    expect(result.rolledBackFromVersion).toBe(2);
    expect(flagRepo.update).toHaveBeenCalledWith(
      { id: 'flag-1', version: 3 },
      expect.objectContaining({
        type: 'percentage',
        enabled: true,
        rolloutPercentage: 42,
        rules: { userIds: ['user-1'] },
        environment: 'staging',
        description: 'historical',
        isPermanent: true,
        metadata: { source: 'history' },
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        version: 4,
      }),
    );

    const restoredSnapshot = versionRepo.insert.mock.calls[0][0];
    expect(restoredSnapshot).toMatchObject({
      flagId: 'flag-1',
      version: 4,
      sourceVersion: 2,
      actorId: 'admin-1',
      changeReason: 'restore incident',
    });

    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rollback',
        actorId: 'admin-1',
        sourceVersion: 2,
        fromVersion: 3,
        toVersion: 4,
        outcome: 'applied',
        beforeState: expect.objectContaining({ environment: 'production' }),
        afterState: expect.objectContaining({ environment: 'staging' }),
      }),
    );

    expect(redis.del).toHaveBeenCalledWith('flag:production:new-ui');
    expect(redis.del).toHaveBeenCalledWith('flag:staging:new-ui');
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('cache'));
    expect(metrics.incrementConfigChanges).toHaveBeenCalledWith(
      'staging',
      'flag',
    );
  });

  it('fails without mutating the flag or invalidating cache when a snapshot is missing', async () => {
    flagRepo.findOne.mockResolvedValue(makeFlag());
    versionRepo.findOne.mockResolvedValueOnce(null);

    await expect(service.rollback('flag-1', 2)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(flagRepo.update).not.toHaveBeenCalled();
    expect(versionRepo.insert).not.toHaveBeenCalled();
    expect(auditRepo.insert).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('rejects a corrupt snapshot without mutating the flag', async () => {
    flagRepo.findOne.mockResolvedValue(makeFlag());
    versionRepo.findOne.mockResolvedValueOnce(
      snapshotFor(configuration(), 2, { contentHash: 'tampered' }),
    );

    await expect(service.rollback('flag-1', 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(flagRepo.update).not.toHaveBeenCalled();
    expect(versionRepo.insert).not.toHaveBeenCalled();
    expect(auditRepo.insert).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('rejects a stale expected version before touching a snapshot', async () => {
    flagRepo.findOne.mockResolvedValue(makeFlag());

    await expect(
      service.rollback('flag-1', 2, 'admin-1', undefined, 2),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(versionRepo.findOne).not.toHaveBeenCalled();
    expect(flagRepo.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('rejects a concurrent update that loses the compare-and-swap race', async () => {
    flagRepo.findOne.mockResolvedValue(makeFlag());
    versionRepo.findOne
      .mockResolvedValueOnce(snapshotFor(configuration(), 2))
      .mockResolvedValueOnce(
        snapshotFor(configuration({ type: 'boolean', enabled: false }), 3),
      );
    flagRepo.update.mockResolvedValue({ affected: 0 });

    await expect(service.rollback('flag-1', 2)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(versionRepo.insert).not.toHaveBeenCalled();
    expect(auditRepo.insert).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('persists a new immutable snapshot on update and invalidates cache after commit', async () => {
    flagRepo.findOne
      .mockResolvedValueOnce(makeFlag())
      .mockResolvedValueOnce(makeFlag({ enabled: true, version: 4 }));
    versionRepo.findOne.mockResolvedValueOnce(
      snapshotFor(configuration({ type: 'boolean', enabled: false }), 3),
    );

    const result = await service.update(
      'flag-1',
      { enabled: true, reason: 'gradual rollout' },
      'admin-2',
    );

    expect(result.version).toBe(4);
    expect(versionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 4,
        sourceVersion: null,
        actorId: 'admin-2',
      }),
    );
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        fromVersion: 3,
        toVersion: 4,
      }),
    );
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('cache'));
  });

  it('records emergency disable as a distinct operation', async () => {
    flagRepo.findOne
      .mockResolvedValueOnce(makeFlag({ enabled: true }))
      .mockResolvedValueOnce(makeFlag({ enabled: false, version: 4 }));
    versionRepo.findOne.mockResolvedValueOnce(
      snapshotFor(configuration({ type: 'boolean', enabled: true }), 3),
    );

    const result = await service.emergencyDisable(
      'flag-1',
      'admin-3',
      'incident',
    );

    expect(result.enabled).toBe(false);
    expect(result.rolledBackFromVersion).toBeNull();
    expect(flagRepo.update).toHaveBeenCalledWith(
      { id: 'flag-1', version: 3 },
      expect.objectContaining({ enabled: false, rolledBackFromVersion: null }),
    );
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'emergency_disable',
        sourceVersion: null,
        reason: 'incident',
      }),
    );
  });
});
