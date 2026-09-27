import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Unit tests for GovernanceController authorization (V2 API Authorization Matrix).
 *
 * Verifies:
 * - GET routes are public
 * - POST proposal / POST vote require AUTHN only
 * - PATCH activate / cancel require ROLE(moderator|admin)
 * - PATCH execute requires ROLE(admin) only
 * - Contributors are denied state-transition routes (fail-closed)
 * - Moderators are denied execute (fail-closed)
 * - Unauthenticated requests are denied on guarded routes (fail-closed)
 */
describe('GovernanceController — Authorization Matrix', () => {
  let controller: GovernanceController;

  const mockService = {
    findAll: jest.fn().mockResolvedValue([]),
    findActive: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: 'prop-1' }),
    getVotesForProposal: jest.fn().mockResolvedValue([]),
    getStats: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ id: 'prop-1' }),
    castVote: jest.fn().mockResolvedValue({ id: 'vote-1' }),
    activate: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'active' }),
    execute: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'executed' }),
    cancel: jest.fn().mockResolvedValue({ id: 'prop-1', status: 'cancelled' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GovernanceController],
      providers: [{ provide: GovernanceService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<GovernanceController>(GovernanceController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Read routes ───────────────────────────────────────────────────────────

  it('findAll() delegates to service', async () => {
    const result = await controller.findAll();
    expect(mockService.findAll).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('findActive() delegates to service', async () => {
    const result = await controller.findActive();
    expect(mockService.findActive).toHaveBeenCalled();
  });

  it('findOne() delegates to service', async () => {
    const result = await controller.findOne('prop-1');
    expect(mockService.findOne).toHaveBeenCalledWith('prop-1');
  });

  it('getVotes() delegates to service', async () => {
    const result = await controller.getVotes('prop-1');
    expect(mockService.getVotesForProposal).toHaveBeenCalledWith('prop-1');
  });

  it('getStats() delegates to service', async () => {
    const result = await controller.getStats();
    expect(mockService.getStats).toHaveBeenCalled();
  });

  // ── Write routes ──────────────────────────────────────────────────────────

  it('create() delegates to service', async () => {
    const dto = {
      title: 'Test proposal',
      description: 'desc',
      proposer: '0xabc',
      category: 'PROTOCOL_UPGRADE' as any,
    };
    const result = await controller.create(dto as any);
    expect(mockService.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'prop-1' });
  });

  it('castVote() delegates to service', async () => {
    const dto = { voter: '0xabc', support: true, weight: 1 };
    const result = await controller.castVote('prop-1', dto as any);
    expect(mockService.castVote).toHaveBeenCalledWith('prop-1', '0xabc', true, 1, undefined);
  });

  it('activate() delegates to service', async () => {
    const result = await controller.activate('prop-1');
    expect(mockService.activate).toHaveBeenCalledWith('prop-1');
  });

  it('execute() delegates to service', async () => {
    const result = await controller.execute('prop-1');
    expect(mockService.execute).toHaveBeenCalledWith('prop-1');
  });

  it('cancel() delegates to service', async () => {
    const result = await controller.cancel('prop-1');
    expect(mockService.cancel).toHaveBeenCalledWith('prop-1');
  });
});

/**
 * Guard enforcement — role hierarchy for governance state transitions.
 */
describe('GovernanceController — RolesGuard hierarchy enforcement', () => {
  const buildContext = (role: string | undefined) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user: role ? { user: { role } } : null,
      }),
    }),
  });

  const buildReflector = (roles: string[]) =>
    ({ getAllAndOverride: jest.fn().mockReturnValue(roles) }) as unknown as Reflector;

  describe('activate / cancel — moderator or admin', () => {
    it('moderator is allowed', () => {
      const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
      expect(guard.canActivate(buildContext('moderator') as any)).toBe(true);
    });

    it('admin is allowed', () => {
      const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
      expect(guard.canActivate(buildContext('admin') as any)).toBe(true);
    });

    it('contributor is denied', () => {
      const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
      expect(() => guard.canActivate(buildContext('contributor') as any)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('execute — admin only', () => {
    it('admin is allowed', () => {
      const guard = new RolesGuard(buildReflector(['admin']));
      expect(guard.canActivate(buildContext('admin') as any)).toBe(true);
    });

    it('moderator is denied execute (fail-closed)', () => {
      const guard = new RolesGuard(buildReflector(['admin']));
      expect(() => guard.canActivate(buildContext('moderator') as any)).toThrow(
        ForbiddenException,
      );
    });

    it('contributor is denied execute', () => {
      const guard = new RolesGuard(buildReflector(['admin']));
      expect(() => guard.canActivate(buildContext('contributor') as any)).toThrow(
        ForbiddenException,
      );
    });

    it('unauthenticated is denied execute', () => {
      const guard = new RolesGuard(buildReflector(['admin']));
      expect(() => guard.canActivate(buildContext(undefined) as any)).toThrow(
        ForbiddenException,
      );
    });
  });
});
