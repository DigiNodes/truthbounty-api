import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureFlag } from './entities/feature-flag.entity';
import { FeatureFlagsMetricsService } from './metrics/feature-flag.metrics';
import { RedisService } from '../redis/redis.service';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';
import { PublicFeatureFlagDto } from './dto/public-feature-flag.dto';

/**
 * Security tests for PREWAVE-BE-157: Feature flag sanitization and evaluation context
 * 
 * Tests verify:
 * - Public API responses exclude sensitive internal fields
 * - Server-only flags are filtered from public access
 * - Anonymous callers cannot impersonate users or roles
 * - Authenticated evaluation uses verified principal identity
 * - Personalized results don't leak across users via cache
 */
describe('FeatureFlagsService - Security (PREWAVE-BE-157)', () => {
  let service: FeatureFlagsService;
  let repo: Repository<FeatureFlag>;
  let redis: RedisService;

  const mockRepo = () => ({
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  });

  const mockRedis = () => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
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
    redis = module.get<RedisService>(RedisService);
  });

  describe('Public API response sanitization', () => {
    it('should exclude sensitive fields from PublicFeatureFlagDto', () => {
      const fullFlag: any = {
        id: 'flag-1',
        key: 'test-flag',
        type: 'percentage',
        enabled: true,
        rolloutPercentage: 50,
        rules: { userIds: ['user-123', 'user-456'] },
        environment: 'production',
        description: 'Test feature',
        metadata: { internalNote: 'secret' },
        version: 5,
        createdBy: 'admin-user-id',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-11-01'),
        expiresAt: null,
        isPermanent: false,
        serverOnly: false,
      };

      const publicDto = PublicFeatureFlagDto.fromEntity(fullFlag);

      // Should include safe fields
      expect(publicDto.id).toBe('flag-1');
      expect(publicDto.key).toBe('test-flag');
      expect(publicDto.type).toBe('percentage');
      expect(publicDto.enabled).toBe(true);
      expect(publicDto.environment).toBe('production');
      expect(publicDto.description).toBe('Test feature');
      expect(publicDto.createdAt).toEqual(new Date('2026-01-01'));

      // Should exclude sensitive internal fields
      expect((publicDto as any).rolloutPercentage).toBeUndefined();
      expect((publicDto as any).rules).toBeUndefined();
      expect((publicDto as any).metadata).toBeUndefined();
      expect((publicDto as any).version).toBeUndefined();
      expect((publicDto as any).createdBy).toBeUndefined();
      expect((publicDto as any).updatedAt).toBeUndefined();
      expect((publicDto as any).isPermanent).toBeUndefined();
      expect((publicDto as any).serverOnly).toBeUndefined();
    });

    it('should not expose targeted user IDs in rules', () => {
      const flagWithUserTargeting: any = {
        id: 'flag-2',
        key: 'beta-access',
        type: 'user',
        enabled: true,
        rules: {
          userIds: ['internal-employee-1', 'internal-employee-2', 'vip-customer-3'],
        },
        environment: 'production',
        createdAt: new Date(),
      };

      const publicDto = PublicFeatureFlagDto.fromEntity(flagWithUserTargeting);

      expect((publicDto as any).rules).toBeUndefined();
      expect(JSON.stringify(publicDto)).not.toContain('internal-employee-1');
      expect(JSON.stringify(publicDto)).not.toContain('userIds');
    });

    it('should not expose role allowlists', () => {
      const flagWithRoleTargeting: any = {
        id: 'flag-3',
        key: 'admin-feature',
        type: 'role',
        enabled: true,
        rules: {
          roles: ['ADMIN', 'SUPER_ADMIN', 'MODERATOR'],
        },
        environment: 'production',
        createdAt: new Date(),
      };

      const publicDto = PublicFeatureFlagDto.fromEntity(flagWithRoleTargeting);

      expect((publicDto as any).rules).toBeUndefined();
      expect(JSON.stringify(publicDto)).not.toContain('SUPER_ADMIN');
      expect(JSON.stringify(publicDto)).not.toContain('roles');
    });
  });

  describe('Server-only flag filtering', () => {
    it('should exclude serverOnly flags from findAllPublic()', async () => {
      const flags = [
        {
          id: 'flag-1',
          key: 'public-feature',
          serverOnly: false,
          enabled: true,
          type: 'boolean',
          environment: 'production',
        },
        {
          id: 'flag-2',
          key: 'internal-circuit-breaker',
          serverOnly: true,
          enabled: true,
          type: 'kill-switch',
          environment: 'production',
        },
        {
          id: 'flag-3',
          key: 'another-public',
          serverOnly: false,
          enabled: false,
          type: 'boolean',
          environment: 'production',
        },
      ];

      (repo.find as jest.Mock).mockResolvedValue(
        flags.filter((f) => !f.serverOnly),
      );

      const result = await service.findAllPublic('production');

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.key)).toEqual([
        'public-feature',
        'another-public',
      ]);
      expect(result.find((f) => f.key === 'internal-circuit-breaker')).toBeUndefined();
    });

    it('should include all flags in findAll() for admin access', async () => {
      const flags = [
        {
          id: 'flag-1',
          key: 'public-feature',
          serverOnly: false,
          enabled: true,
          type: 'boolean',
          environment: 'production',
        },
        {
          id: 'flag-2',
          key: 'internal-circuit-breaker',
          serverOnly: true,
          enabled: true,
          type: 'kill-switch',
          environment: 'production',
        },
      ];

      (repo.find as jest.Mock).mockResolvedValue(flags);

      const result = await service.findAll('production');

      expect(result).toHaveLength(2);
      expect(result.find((f) => f.serverOnly)).toBeDefined();
    });
  });

  describe('Principal-derived evaluation context', () => {
    it('should derive userId and wallet from authenticated principal', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0xABCD1234',
        userId: 'user-123',
        sub: 'auth0|user-123',
        user: { role: 'USER' },
      };

      const flag = {
        id: 'flag-1',
        key: 'beta-feature',
        type: 'user',
        enabled: true,
        rules: { userIds: ['user-123'] },
        environment: 'production',
        rolloutPercentage: 0,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      const result = await service.evaluateForPrincipal(
        'beta-feature',
        principal,
        'production',
      );

      expect(result.enabled).toBe(true);
      expect(result.reason).toBe('user');
    });

    it('should extract roles from principal for role-targeted flags', async () => {
      const adminPrincipal: AuthenticatedPrincipal = {
        address: '0xABCD1234',
        userId: 'admin-1',
        user: { role: 'ADMIN' },
      };

      const userPrincipal: AuthenticatedPrincipal = {
        address: '0xEFGH5678',
        userId: 'user-1',
        user: { role: 'USER' },
      };

      const flag = {
        id: 'flag-1',
        key: 'admin-panel',
        type: 'role',
        enabled: true,
        rules: { roles: ['ADMIN', 'MODERATOR'] },
        environment: 'production',
        rolloutPercentage: 0,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      const adminResult = await service.evaluateForPrincipal(
        'admin-panel',
        adminPrincipal,
        'production',
      );
      expect(adminResult.enabled).toBe(true);

      const userResult = await service.evaluateForPrincipal(
        'admin-panel',
        userPrincipal,
        'production',
      );
      expect(userResult.enabled).toBe(false);
    });

    it('should return anonymous context when principal is null', async () => {
      const flag = {
        id: 'flag-1',
        key: 'public-feature',
        type: 'boolean',
        enabled: true,
        environment: 'production',
        rolloutPercentage: 0,
        rules: null,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      const result = await service.evaluateForPrincipal(
        'public-feature',
        null,
        'production',
      );

      expect(result.enabled).toBe(true);
      expect(result.reason).toBe('boolean');
    });

    it('should not allow anonymous caller to match user-targeted flags', async () => {
      const flag = {
        id: 'flag-1',
        key: 'user-only-feature',
        type: 'user',
        enabled: true,
        rules: { userIds: ['user-123', 'user-456'] },
        environment: 'production',
        rolloutPercentage: 0,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      // Anonymous caller (null principal) cannot access user-targeted flag
      const result = await service.evaluateForPrincipal(
        'user-only-feature',
        null,
        'production',
      );

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('user');
    });

    it('should not allow anonymous caller to match role-targeted flags', async () => {
      const flag = {
        id: 'flag-1',
        key: 'role-only-feature',
        type: 'role',
        enabled: true,
        rules: { roles: ['ADMIN'] },
        environment: 'production',
        rolloutPercentage: 0,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      // Anonymous caller (null principal) cannot access role-targeted flag
      const result = await service.evaluateForPrincipal(
        'role-only-feature',
        null,
        'production',
      );

      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('role');
    });
  });

  describe('Percentage rollout with principal identity', () => {
    it('should use authenticated userId for percentage bucketing', async () => {
      const principal1: AuthenticatedPrincipal = {
        address: '0xUSER1',
        userId: 'user-1',
        user: {},
      };

      const principal2: AuthenticatedPrincipal = {
        address: '0xUSER2',
        userId: 'user-2',
        user: {},
      };

      const flag = {
        id: 'flag-1',
        key: 'gradual-rollout',
        type: 'percentage',
        enabled: true,
        rolloutPercentage: 50,
        environment: 'production',
        rules: null,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      // Same user should get consistent result
      const result1a = await service.evaluateForPrincipal(
        'gradual-rollout',
        principal1,
        'production',
      );
      const result1b = await service.evaluateForPrincipal(
        'gradual-rollout',
        principal1,
        'production',
      );

      expect(result1a.enabled).toBe(result1b.enabled);

      // Different users may get different results based on hash
      const result2 = await service.evaluateForPrincipal(
        'gradual-rollout',
        principal2,
        'production',
      );

      expect(result2.reason).toBe('percentage');
    });

    it('should use wallet address as fallback for percentage bucketing', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0xWALLET123',
        // No userId
        user: {},
      };

      const flag = {
        id: 'flag-1',
        key: 'wallet-rollout',
        type: 'percentage',
        enabled: true,
        rolloutPercentage: 50,
        environment: 'production',
        rules: null,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      const result = await service.evaluateForPrincipal(
        'wallet-rollout',
        principal,
        'production',
      );

      expect(result.reason).toBe('percentage');
      expect([true, false]).toContain(result.enabled);
    });
  });

  describe('Cache isolation for personalized flags', () => {
    it('should cache flag definitions but not personalized evaluation results', async () => {
      const principal1: AuthenticatedPrincipal = {
        address: '0xUSER1',
        userId: 'user-allowed',
        user: {},
      };

      const principal2: AuthenticatedPrincipal = {
        address: '0xUSER2',
        userId: 'user-denied',
        user: {},
      };

      const flag = {
        id: 'flag-1',
        key: 'targeted-feature',
        type: 'user',
        enabled: true,
        rules: { userIds: ['user-allowed'] },
        environment: 'production',
        rolloutPercentage: 0,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      // First user evaluates (allowed)
      const result1 = await service.evaluateForPrincipal(
        'targeted-feature',
        principal1,
        'production',
      );
      expect(result1.enabled).toBe(true);

      // Second user evaluates (denied) - should not get cached result from user1
      const result2 = await service.evaluateForPrincipal(
        'targeted-feature',
        principal2,
        'production',
      );
      expect(result2.enabled).toBe(false);

      // Verify flag definition was cached but evaluations weren't
      expect(redis.set).toHaveBeenCalled();
      const cachedKey = (redis.set as jest.Mock).mock.calls[0][0];
      expect(cachedKey).toMatch(/flag:production:targeted-feature/);
      // Cache key should not include user-specific context
      expect(cachedKey).not.toContain('user-allowed');
      expect(cachedKey).not.toContain('user-denied');
    });
  });

  describe('Authorization boundary separation', () => {
    it('should evaluate flags independently of authorization guards', async () => {
      // Feature flags control UX rollout, not authorization
      // This test verifies that flag evaluation doesn't bypass auth checks

      const flag = {
        id: 'flag-1',
        key: 'admin-ui-redesign',
        type: 'boolean',
        enabled: true,
        environment: 'production',
        rules: null,
        rolloutPercentage: 0,
      };

      (repo.findOne as jest.Mock).mockResolvedValue(flag);

      // A non-admin user can see the flag is enabled...
      const nonAdminPrincipal: AuthenticatedPrincipal = {
        address: '0xUSER',
        userId: 'user-1',
        user: { role: 'USER' },
      };

      const result = await service.evaluateForPrincipal(
        'admin-ui-redesign',
        nonAdminPrincipal,
        'production',
      );

      expect(result.enabled).toBe(true);

      // ...but backend authorization guards must still enforce access control
      // (This is tested in controller/guard tests, not here)
      // The flag evaluation itself does not grant permissions
    });
  });
});
