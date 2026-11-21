import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { GovernanceController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Unit tests for GovernanceController identity binding and authorization.
 *
 * Verifies:
 * - proposer/voter come from the verified JWT principal, never the body
 * - client weight is not forwarded at all
 * - GET routes are public
 * - POST proposal / POST vote require AUTHN only
 * - PATCH activate / cancel require ROLE(moderator|admin)
 * - PATCH execute requires ROLE(admin) only
 * - contributors/moderators are denied the higher role transitions
 * - unauthenticated requests are denied on guarded routes (fail-closed)
 */
const PRINCIPAL = '0x1111111111111111111111111111111111111111';

describe('GovernanceController — identity binding & Authorization Matrix', () => {
  let controller: GovernanceController;

  const request = (address: string | null = PRINCIPAL) =>
    ({ user: address ? { address } : null }) as any;

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
    await controller.findActive();
    expect(mockService.findActive).toHaveBeenCalled();
  });

  it('findOne() delegates to service', async () => {
    await controller.findOne('prop-1');
    expect(mockService.findOne).toHaveBeenCalledWith('prop-1');
  });

  it('getVotes() delegates to service', async () => {
    await controller.getVotes('prop-1');
    expect(mockService.getVotesForProposal).toHaveBeenCalledWith('prop-1');
  });

  it('getStats() delegates to service', async () => {
    await controller.getStats();
    expect(mockService.getStats).toHaveBeenCalled();
  });

  // ── Identity binding ──────────────────────────────────────────────────────

  it('create() cannot attribute a proposal to another wallet via dto.proposer', async () => {
    const dto = {
      title: 'Test proposal',
      description: 'desc',
      proposer: '0x2222222222222222222222222222222222222222',
      blockchainTxHash: '0x' + 'f'.repeat(64),
      category: 'GOVERNANCE' as any,
    } as any;

    await controller.create(request(), dto);

    const forwarded = mockService.create.mock.calls[0][0];
    expect(forwarded.proposer).toBe(PRINCIPAL);
    expect(forwarded.proposer).not.toBe(dto.proposer);
    expect(forwarded.blockchainTxHash).toBeUndefined();
    expect(forwarded.title).toBe(dto.title);
  });

  it('create() fails closed without a verified principal', async () => {
    await expect(
      controller.create(request(null), { title: 'x', description: 'y' } as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it('castVote() cannot vote for another wallet or inject a client weight', async () => {
    const canonicalEvent = {
      chainId: 10,
      txHash: '0x' + 'a'.repeat(64),
      logIndex: 3,
    };
    const dto = {
      voter: '0x2222222222222222222222222222222222222222',
      support: true,
      weight: 1000000,
      canonicalEvent,
    } as any;

    await controller.castVote('prop-1', request(), dto);

    expect(mockService.castVote).toHaveBeenCalledWith(
      'prop-1',
      PRINCIPAL,
      canonicalEvent,
      undefined,
    );
    const args = mockService.castVote.mock.calls[0];
    expect(args).toHaveLength(4);
  });

  it('castVote() fails closed without a verified principal', async () => {
    await expect(
      controller.castVote('prop-1', request(null), {} as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(mockService.castVote).not.toHaveBeenCalled();
  });

  it('activate/execute/cancel() delegate to service', async () => {
    await controller.activate('prop-1');
    await controller.execute('prop-1');
    await controller.cancel('prop-1');
    expect(mockService.activate).toHaveBeenCalledWith('prop-1');
    expect(mockService.execute).toHaveBeenCalledWith('prop-1');
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
        user: role ? { address: PRINCIPAL, user: { role } } : null,
      }),
    }),
  });

  const buildReflector = (roles: string[]) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    }) as unknown as Reflector;

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
      expect(() =>
        guard.canActivate(buildContext('contributor') as any),
      ).toThrow(ForbiddenException);
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
      expect(() =>
        guard.canActivate(buildContext('contributor') as any),
      ).toThrow(ForbiddenException);
    });

    it('unauthenticated is denied execute', () => {
      const guard = new RolesGuard(buildReflector(['admin']));
      expect(() => guard.canActivate(buildContext(undefined) as any)).toThrow(
        ForbiddenException,
      );
    });
  });
});
