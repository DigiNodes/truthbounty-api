import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeTrigger } from './entities/dispute.entity';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../auth/types/authenticated-request';

const PRINCIPAL = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const requestWith = (address?: string): AuthenticatedRequest =>
  ({ user: { address } }) as AuthenticatedRequest;

describe('DisputeController — authorization and authority boundary', () => {
  let controller: DisputeController;

  const mockDisputeService: Partial<DisputeService> = {
    createDispute: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
    startReview: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
    projectOutcome: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
    recordTriage: jest.fn().mockResolvedValue({ id: 'dispute-1' }),
    getDisputeByClaimId: jest.fn().mockResolvedValue(null),
    getExpiredDisputes: jest.fn().mockResolvedValue([]),
    findAll: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisputeController],
      providers: [{ provide: DisputeService, useValue: mockDisputeService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DisputeController>(DisputeController);
  });

  afterEach(() => jest.clearAllMocks());

  it('findAll()/getExpired()/getByClaimId() delegate to the service', async () => {
    expect(await controller.findAll()).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(await controller.getExpired()).toEqual([]);
    await controller.getByClaimId('claim-abc');
    expect(mockDisputeService.getDisputeByClaimId).toHaveBeenCalledWith(
      'claim-abc',
    );
  });

  it('create() derives the initiator from the verified principal only', async () => {
    const dto = {
      claimId: 'claim-1',
      trigger: DisputeTrigger.MANUAL,
      originalConfidence: 0.4,
      initiatorId: '0xattacker',
      canonicalEvent: {
        chainId: 10,
        txHash: '0x' + 'd'.repeat(64),
        logIndex: 1,
      },
    };
    await controller.create(requestWith(PRINCIPAL), dto as any);
    expect(mockDisputeService.createDispute).toHaveBeenCalledWith({
      claimId: 'claim-1',
      principal: PRINCIPAL,
      canonicalEvent: dto.canonicalEvent,
      metadata: undefined,
    });
  });

  it('create() fails closed without a verified principal', async () => {
    await expect(
      controller.create(requestWith(undefined), {} as any),
    ).rejects.toThrow(UnauthorizedException);
    expect(mockDisputeService.createDispute).not.toHaveBeenCalled();
  });

  it('startReview() forwards the id', async () => {
    await controller.startReview('dispute-1');
    expect(mockDisputeService.startReview).toHaveBeenCalledWith('dispute-1');
  });

  it('projectOutcome() forwards only the canonical log pointer', async () => {
    const dto = {
      canonicalEvent: {
        chainId: 10,
        txHash: '0x' + 'f'.repeat(64),
        logIndex: 3,
      },
      outcome: 'CONFIRMED',
      finalConfidence: 0.99,
    };
    await controller.projectOutcome('dispute-1', dto as any);
    expect(mockDisputeService.projectOutcome).toHaveBeenCalledWith({
      disputeId: 'dispute-1',
      canonicalEvent: dto.canonicalEvent,
      metadata: undefined,
    });
    expect(mockDisputeService.recordTriage).not.toHaveBeenCalled();
  });

  it('deprecated resolve() records triage instead of a terminal outcome', async () => {
    await controller.resolve('dispute-1', requestWith(PRINCIPAL), {
      note: 'reviewed',
    } as any);
    expect(mockDisputeService.recordTriage).toHaveBeenCalledWith({
      disputeId: 'dispute-1',
      principal: PRINCIPAL,
      note: 'reviewed',
      metadata: undefined,
    });
    expect(mockDisputeService.projectOutcome).not.toHaveBeenCalled();
  });

  it('deprecated reject() records triage with the verified principal', async () => {
    await controller.reject('dispute-1', requestWith(PRINCIPAL), {
      reason: 'spam',
      rejectedBy: '0xattacker',
    } as any);
    expect(mockDisputeService.recordTriage).toHaveBeenCalledWith({
      disputeId: 'dispute-1',
      principal: PRINCIPAL,
      reason: 'spam',
    });
    expect(mockDisputeService.recordTriage).not.toHaveBeenCalledWith(
      expect.objectContaining({ rejectedBy: '0xattacker' }),
    );
  });
});

describe('DisputeController — RolesGuard enforcement', () => {
  const buildContext = (role: string | undefined) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () =>
        role
          ? { user: { address: PRINCIPAL, user: { role } } }
          : { user: null },
    }),
  });

  const buildReflector = (roles: string[] | undefined) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    }) as unknown as Reflector;

  it('contributor is denied state-transition routes', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(() => guard.canActivate(buildContext('contributor') as any)).toThrow(
      ForbiddenException,
    );
  });

  it('moderator/admin are allowed on projection and workflow routes', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(guard.canActivate(buildContext('moderator') as any)).toBe(true);
    expect(guard.canActivate(buildContext('admin') as any)).toBe(true);
  });

  it('unauthenticated request is denied', () => {
    const guard = new RolesGuard(buildReflector(['moderator', 'admin']));
    expect(() => guard.canActivate(buildContext(undefined) as any)).toThrow(
      ForbiddenException,
    );
  });
});
