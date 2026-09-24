import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlag } from './entities/feature-flag.entity';
import { FeatureFlagsMetricsService } from './metrics/feature-flag.metrics';
import { RedisService } from '../redis/redis.service';

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;
  let repo: Repository<FeatureFlag>;

  const mockRepo = () => ({
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  });

  const mockRedis = () => ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  });

  const mockMetrics = () => ({
    recordActiveFlags: jest.fn(),
    recordDisabledFlags: jest.fn(),
    incrementConfigChanges: jest.fn(),
    recordCacheHitRatio: jest.fn(),
    observeRefreshLatency: jest.fn(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagsService,
        { provide: getRepositoryToken(FeatureFlag), useFactory: mockRepo },
        { provide: RedisService, useFactory: mockRedis },
        { provide: FeatureFlagsMetricsService, useFactory: mockMetrics },
      ],
    }).compile();

    service = module.get<FeatureFlagsService>(FeatureFlagsService);
    repo = module.get<Repository<FeatureFlag>>(getRepositoryToken(FeatureFlag));
  });

  it('should evaluate boolean flag', async () => {
    (repo.findOne as jest.Mock).mockResolvedValue({
      id: '1',
      key: 'new-ui',
      type: 'boolean',
      enabled: true,
      environment: 'development',
      rolloutPercentage: 0,
      rules: null,
      version: 1,
    });

    const result = await service.evaluate('new-ui');
    expect(result.enabled).toBe(true);
  });

  it('should evaluate disabled flag', async () => {
    (repo.findOne as jest.Mock).mockResolvedValue({
      id: '1',
      key: 'new-ui',
      type: 'boolean',
      enabled: false,
      environment: 'development',
      rolloutPercentage: 0,
      rules: null,
      version: 1,
    });

    const result = await service.evaluate('new-ui');
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('should evaluate user flag', async () => {
    (repo.findOne as jest.Mock).mockResolvedValue({
      id: '1',
      key: 'beta-feature',
      type: 'user',
      enabled: true,
      environment: 'development',
      rolloutPercentage: 0,
      rules: { userIds: ['user-123'] },
      version: 1,
    });

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
    (repo.findOne as jest.Mock).mockResolvedValue({
      id: '1',
      key: 'admin-tool',
      type: 'role',
      enabled: true,
      environment: 'development',
      rolloutPercentage: 0,
      rules: { roles: ['admin'] },
      version: 1,
    });

    const included = await service.evaluate('admin-tool', { roles: ['admin'] });
    expect(included.enabled).toBe(true);

    const excluded = await service.evaluate('admin-tool', { roles: ['user'] });
    expect(excluded.enabled).toBe(false);
  });
});
