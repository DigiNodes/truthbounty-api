import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsService } from './feature-flags.service';
import { ConfigurationService } from './configuration.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';
import { PublicFeatureFlagDto } from './dto/public-feature-flag.dto';
import { FeatureFlagEvaluationDto } from './dto/evaluate-flag.dto';

/**
 * Controller security tests for PREWAVE-BE-157
 * 
 * Verifies that public endpoints:
 * - Return only sanitized DTOs
 * - Filter server-only flags
 * - Use authenticated principals (not query params)
 * - Cannot be used to impersonate users or roles
 */
describe('FeatureFlagsController - Public API Security (PREWAVE-BE-157)', () => {
  let controller: FeatureFlagsController;
  let flagsService: FeatureFlagsService;

  const mockFlagsService = {
    findAllPublic: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    evaluateForPrincipal: jest.fn(),
    evaluate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    toggle: jest.fn(),
    rollback: jest.fn(),
  };

  const mockConfigService = {
    findAll: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getHistory: jest.fn(),
    rollback: jest.fn(),
    findOne: jest.fn(),
    getRequired: jest.fn(),
  };

  const mockAuditService = {
    log: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeatureFlagsController],
      providers: [
        { provide: FeatureFlagsService, useValue: mockFlagsService },
        { provide: ConfigurationService, useValue: mockConfigService },
        { provide: AuditTrailService, useValue: mockAuditService },
      ],
    }).compile();

    controller = module.get<FeatureFlagsController>(FeatureFlagsController);
    flagsService = module.get<FeatureFlagsService>(FeatureFlagsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /feature-flags (public list)', () => {
    it('should return only public feature flags as DTOs', async () => {
      const flags = [
        {
          id: 'flag-1',
          key: 'public-feature',
          type: 'boolean',
          enabled: true,
          environment: 'production',
          description: 'Public feature',
          createdAt: new Date('2026-01-01'),
          serverOnly: false,
          // These should be excluded from DTO
          rolloutPercentage: 50,
          rules: { userIds: ['user-123'] },
          metadata: { internal: 'secret' },
          version: 5,
          createdBy: 'admin-id',
        },
      ];

      mockFlagsService.findAllPublic.mockResolvedValue(flags);

      const result = await controller.listFlags({ environment: 'production' });

      expect(mockFlagsService.findAllPublic).toHaveBeenCalledWith('production');
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(PublicFeatureFlagDto);
      expect(result[0].key).toBe('public-feature');
      expect((result[0] as any).rolloutPercentage).toBeUndefined();
      expect((result[0] as any).rules).toBeUndefined();
      expect((result[0] as any).metadata).toBeUndefined();
      expect((result[0] as any).version).toBeUndefined();
      expect((result[0] as any).createdBy).toBeUndefined();
    });

    it('should not include server-only flags', async () => {
      const publicFlags = [
        {
          id: 'flag-1',
          key: 'public-feature',
          serverOnly: false,
          type: 'boolean',
          enabled: true,
          environment: 'production',
          createdAt: new Date(),
        },
      ];

      // findAllPublic already filters server-only flags
      mockFlagsService.findAllPublic.mockResolvedValue(publicFlags);

      const result = await controller.listFlags({ environment: 'production' });

      expect(result.every((f) => (f as any).serverOnly !== true)).toBe(true);
      expect(result.find((f) => f.key === 'internal-flag')).toBeUndefined();
    });
  });

  describe('GET /feature-flags/:id (public get)', () => {
    it('should return sanitized DTO for public flag', async () => {
      const flag = {
        id: 'flag-1',
        key: 'public-feature',
        type: 'boolean',
        enabled: true,
        environment: 'production',
        description: 'Public feature',
        createdAt: new Date('2026-01-01'),
        serverOnly: false,
        rolloutPercentage: 0,
        rules: null,
        metadata: null,
        version: 1,
        createdBy: 'admin',
      };

      mockFlagsService.findOne.mockResolvedValue(flag);

      const result = await controller.getFlag('flag-1');

      expect(result).toBeInstanceOf(PublicFeatureFlagDto);
      expect(result.key).toBe('public-feature');
      expect((result as any).serverOnly).toBeUndefined();
      expect((result as any).createdBy).toBeUndefined();
    });

    it('should reject server-only flags', async () => {
      const serverOnlyFlag = {
        id: 'flag-1',
        key: 'internal-circuit-breaker',
        type: 'kill-switch',
        enabled: true,
        environment: 'production',
        serverOnly: true,
        createdAt: new Date(),
      };

      mockFlagsService.findOne.mockResolvedValue(serverOnlyFlag);

      await expect(controller.getFlag('flag-1')).rejects.toThrow(
        'Feature flag not found',
      );
    });
  });

  describe('GET /feature-flags/evaluate/:key (public evaluation)', () => {
    it('should use authenticated principal, not query parameters', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0xABCD1234',
        userId: 'user-123',
        user: { role: 'USER' },
      };

      const evaluationResult = {
        key: 'beta-feature',
        enabled: true,
        reason: 'user',
      };

      mockFlagsService.evaluateForPrincipal.mockResolvedValue(evaluationResult);

      const result = await controller.evaluateFlag(
        'beta-feature',
        { environment: 'production' },
        principal,
      );

      // Verify service was called with principal, not query params
      expect(mockFlagsService.evaluateForPrincipal).toHaveBeenCalledWith(
        'beta-feature',
        principal,
        'production',
      );

      // Verify response includes authenticated flag
      expect(result).toBeInstanceOf(FeatureFlagEvaluationDto);
      expect(result.key).toBe('beta-feature');
      expect(result.enabled).toBe(true);
      expect(result.authenticated).toBe(true);
    });

    it('should support anonymous evaluation with explicit anonymous context', async () => {
      const evaluationResult = {
        key: 'public-feature',
        enabled: true,
        reason: 'boolean',
      };

      mockFlagsService.evaluateForPrincipal.mockResolvedValue(evaluationResult);

      // No principal provided (anonymous caller)
      const result = await controller.evaluateFlag(
        'public-feature',
        { environment: 'production' },
        undefined, // no authenticated user
      );

      // Verify service was called with null principal
      expect(mockFlagsService.evaluateForPrincipal).toHaveBeenCalledWith(
        'public-feature',
        null,
        'production',
      );

      expect(result.authenticated).toBe(false);
    });

    it('should not accept userId or roles from query parameters', async () => {
      // The old insecure signature accepted userId and roles from query params.
      // The new secure endpoint only accepts environment and derives identity from principal.

      const principal: AuthenticatedPrincipal = {
        address: '0xUSER',
        userId: 'real-user-id',
        user: { role: 'USER' },
      };

      const evaluationResult = {
        key: 'test-flag',
        enabled: false,
        reason: 'user',
      };

      mockFlagsService.evaluateForPrincipal.mockResolvedValue(evaluationResult);

      // Even if an attacker tries to pass userId/roles, they're ignored
      // The controller signature doesn't accept them anymore
      const result = await controller.evaluateFlag(
        'test-flag',
        { environment: 'production' },
        principal,
      );

      // Verify the service received the actual principal
      expect(mockFlagsService.evaluateForPrincipal).toHaveBeenCalledWith(
        'test-flag',
        principal,
        'production',
      );

      expect(result.key).toBe('test-flag');
    });

    it('should return evaluation result without exposing internal rules', async () => {
      const principal: AuthenticatedPrincipal = {
        address: '0xUSER',
        userId: 'user-1',
        user: { role: 'USER' },
      };

      const evaluationResult = {
        key: 'gradual-rollout',
        enabled: true,
        reason: 'percentage',
      };

      mockFlagsService.evaluateForPrincipal.mockResolvedValue(evaluationResult);

      const result = await controller.evaluateFlag(
        'gradual-rollout',
        { environment: 'production' },
        principal,
      );

      // Response should not include rolloutPercentage, rules, or targeting logic
      expect((result as any).rolloutPercentage).toBeUndefined();
      expect((result as any).rules).toBeUndefined();
      expect((result as any).targetedUserIds).toBeUndefined();

      // Only includes evaluation outcome and reason category
      expect(result.key).toBe('gradual-rollout');
      expect(result.enabled).toBe(true);
      expect(result.reason).toBe('percentage');
    });
  });

  describe('Admin endpoints - full access', () => {
    it('should allow admins to see all flags including server-only', async () => {
      const allFlags = [
        {
          id: 'flag-1',
          key: 'public-feature',
          serverOnly: false,
          type: 'boolean',
          enabled: true,
          environment: 'production',
        },
        {
          id: 'flag-2',
          key: 'internal-circuit-breaker',
          serverOnly: true,
          type: 'kill-switch',
          enabled: true,
          environment: 'production',
        },
      ];

      mockFlagsService.findAll.mockResolvedValue(allFlags);

      const result = await controller.listFlagsAdmin('production');

      expect(mockFlagsService.findAll).toHaveBeenCalledWith('production');
      expect(result).toHaveLength(2);
      expect(result.find((f) => f.serverOnly)).toBeDefined();
    });

    it('should allow admins to see complete flag details', async () => {
      const completeFlag = {
        id: 'flag-1',
        key: 'beta-feature',
        type: 'user',
        enabled: true,
        serverOnly: false,
        rolloutPercentage: 0,
        rules: { userIds: ['user-123', 'user-456'] },
        metadata: { owner: 'product-team' },
        version: 5,
        createdBy: 'admin-user',
        environment: 'production',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockFlagsService.findOne.mockResolvedValue(completeFlag);

      const result = await controller.getFlagAdmin('flag-1');

      // Admin endpoint returns full entity, not sanitized DTO
      expect(result.rules).toBeDefined();
      expect(result.rules.userIds).toEqual(['user-123', 'user-456']);
      expect(result.metadata).toBeDefined();
      expect(result.version).toBe(5);
      expect(result.createdBy).toBe('admin-user');
    });
  });

  describe('Input validation', () => {
    it('should validate environment parameter format', async () => {
      mockFlagsService.findAllPublic.mockResolvedValue([]);

      // Valid environments
      await expect(
        controller.listFlags({ environment: 'production' }),
      ).resolves.toBeDefined();
      await expect(
        controller.listFlags({ environment: 'staging' }),
      ).resolves.toBeDefined();
      await expect(
        controller.listFlags({ environment: 'dev-123' }),
      ).resolves.toBeDefined();

      // Invalid environments would be rejected by class-validator in the DTO
      // (This is typically tested in integration tests with the validation pipe)
    });
  });
});
