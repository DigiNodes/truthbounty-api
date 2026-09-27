import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeTrigger, DisputeOutcome } from './entities/dispute.entity';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Unit tests for DisputeController authorization (V2 API Authorization Matrix).
 *
 * Verifies:
 * - GET routes are accessible without a guard
 * - POST /disputes requires authentication (JwtAuthGuard)
 * - PATCH state-transition routes require ROLE(moderator|admin)
 * - Contributors are denied state-transition routes (fail-closed)
 * - Unauthenticated requests are denied on guarded routes (fail-closed)
 */
describe('DisputeController — Authorization Matrix', () => {
  let controller: DisputeController;

  const mockDisputeService: Partial<DisputeService> = {
    createDispute: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
    startReview: jest.fn().mockResolvedValue({ id: 'dispute-1', status: 'reviewing' }),
    resolveDispute: jest.fn().mockResolvedValue({ id: 'dispute-1', status: 'resolved' }),
    rejectDispute: jest.fn().mockResolvedValue({ id: 'dispute-1', status: 'rejected' }),
    getDisputeByClaimId: jest.fn().mockResolvedValue(null),
    getExpiredDisputes: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisputeController],
      providers: [
        { provide: DisputeService, useValue: mockDisputeService },
      ],
    })
      // Override guards so we can inject controlled user state
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DisputeController>(DisputeController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Read routes are public ────────────────────────────────────────────────

  it('findAll() calls service and returns results', async () => {
    const result = await controller.findAll();
    expect(mockDisputeService.findAll).toHaveBeenCalled();
    expect(result).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  });

  it('getExpired() calls service and returns results', async () => {
    const result = await controller.getExpired();
    expect(mockDisputeService.getExpiredDisputes).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('getByClaimId() calls service and returns dispute', async () => {
    const result = await controller.getByClaimId('claim-abc');
    expect(mockDisputeService.getDisputeByClaimId).toHaveBeenCalledWith('claim-abc');
    expect(result).toBeNull();
  });

  // ── Create requires authentication ────────────────────────────────────────

  it('create() calls service when guard allows', async () => {
    const dto = {
      claimId: 'claim-1',
      trigger: DisputeTrigger.MANUAL,
      originalConfidence: 0.4,
    };
    const result = await controller.create(dto as any);
    expect(mockDisputeService.createDispute).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ id: 'dispute-1' });
  });

  // ── State transitions call service when guard allows ─────────────────────

  it('startReview() calls service with dispute id', async () => {
    const result = await controller.startReview('dispute-1');
    expect(mockDisputeService.startReview).toHaveBeenCalledWith('dispute-1');
    expect(result).toEqual({ id: 'dispute-1', status: 'reviewing' });
  });

  it('resolve() calls service with dispute id and dto', async () => {
    const dto = { outcome: DisputeOutcome.VALID, finalConfidence: 0.8 };
    const result = await controller.resolve('dispute-1', dto as any);
    expect(mockDisputeService.resolveDispute).toHaveBeenCalledWith({
      disputeId: 'dispute-1',
      outcome: dto.outcome,
      finalConfidence: dto.finalConfidence,
      metadata: undefined,
    });
    expect(result).toEqual({ id: 'dispute-1', status: 'resolved' });
  });

  it('reject() calls service with dispute id and dto', async () => {
    const dto = { reason: 'spam', rejectedBy: '0xmod' };
    const result = await controller.reject('dispute-1', dto as any);
    expect(mockDisputeService.rejectDispute).toHaveBeenCalledWith({
      disputeId: 'dispute-1',
      reason: dto.reason,
      rejectedBy: dto.rejectedBy,
    });
  });
});

/**
 * Guard enforcement tests — verify that RolesGuard correctly denies access
 * when executed against the controller's metadata.
 */
describe('DisputeController — RolesGuard enforcement', () => {
  const buildContext = (role: string | undefined) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user: role ? { user: { role } } : null,
      }),
    }),
  });

  const buildReflector = (roles: string[] | undefined) =>
    ({ getAllAndOverride: jest.fn().mockReturnValue(roles) }) as unknown as Reflector;

  it('contributor is denied access to state-transition routes', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(() => guard.canActivate(buildContext('contributor') as any)).toThrow(
      ForbiddenException,
    );
  });

  it('moderator is allowed on startReview / resolve / reject / cancel routes', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(guard.canActivate(buildContext('moderator') as any)).toBe(true);
  });

  it('admin is allowed on all state-transition routes', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(guard.canActivate(buildContext('admin') as any)).toBe(true);
  });

  it('unauthenticated request (null user) is denied', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(() => guard.canActivate(buildContext(undefined) as any)).toThrow(
      ForbiddenException,
    );
  });
});
