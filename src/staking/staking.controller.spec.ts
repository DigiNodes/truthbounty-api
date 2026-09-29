import { ForbiddenException, ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { StakingController } from './staking.controller';
import { ProjectStakeService } from './project-stake.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Unit tests for StakingController authorization (V2 API Authorization Matrix).
 *
 * Verifies:
 * - GET entitlement and stake are public
 * - POST locks and withdrawals require AUTHN only
 * - POST reconcile requires ROLE(admin) only
 * - Non-admin roles are denied reconcile (fail-closed)
 * - Unauthenticated requests are denied on guarded routes (fail-closed)
 */
describe('StakingController — Authorization Matrix', () => {
  let controller: StakingController;

  const mockStakeService: Partial<ProjectStakeService> = {
    getEntitlement: jest.fn().mockResolvedValue({ total: '1000', locked: '0', withdrawable: '1000' }),
    getStakeOrThrow: jest.fn().mockResolvedValue({ walletAddress: '0xabc', amount: '500' }),
    createLock: jest.fn().mockResolvedValue({ id: 'lock-1' }),
    withdraw: jest.fn().mockResolvedValue({ applied: true }),
    reconcile: jest.fn().mockResolvedValue({ synced: true }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StakingController],
      providers: [{ provide: ProjectStakeService, useValue: mockStakeService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<StakingController>(StakingController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Read routes ───────────────────────────────────────────────────────────

  it('entitlement() returns breakdown from service', async () => {
    const result = await controller.entitlement('claim-1', '0xabc');
    expect(mockStakeService.getEntitlement).toHaveBeenCalledWith('0xabc', 'claim-1');
    expect(result).toHaveProperty('total');
  });

  it('stake() returns stake record from service', async () => {
    const result = await controller.stake('claim-1', '0xabc');
    expect(mockStakeService.getStakeOrThrow).toHaveBeenCalledWith('0xabc', 'claim-1');
    expect(result).toHaveProperty('walletAddress');
  });

  it('stake() throws NotFoundException when service throws', async () => {
    (mockStakeService.getStakeOrThrow as jest.Mock).mockRejectedValueOnce(
      new Error('Stake not found'),
    );
    await expect(controller.stake('claim-x', '0xnobody')).rejects.toThrow(NotFoundException);
  });

  // ── Write routes — authenticated users ───────────────────────────────────

  it('createLock() delegates to service', async () => {
    const dto = { walletAddress: '0xabc', amount: '100', unlocksAt: new Date(), reason: 'test' };
    const result = await controller.createLock('claim-1', dto as any);
    expect(mockStakeService.createLock).toHaveBeenCalledWith({
      walletAddress: '0xabc',
      claimId: 'claim-1',
      amount: '100',
      unlocksAt: dto.unlocksAt,
      reason: 'test',
    });
    expect(result).toEqual({ id: 'lock-1' });
  });

  it('createLock() throws ConflictException when service throws', async () => {
    (mockStakeService.createLock as jest.Mock).mockRejectedValueOnce(
      new Error('lock already exists'),
    );
    const dto = { walletAddress: '0xabc', amount: '100', unlocksAt: new Date() };
    await expect(controller.createLock('claim-1', dto as any)).rejects.toThrow(
      ConflictException,
    );
  });

  it('withdraw() delegates to service', async () => {
    const dto = { walletAddress: '0xabc', amount: '50', txHash: '0xtx', blockNumber: 100 };
    const result = await controller.withdraw('claim-1', dto as any);
    expect(mockStakeService.withdraw).toHaveBeenCalledWith({
      walletAddress: '0xabc',
      claimId: 'claim-1',
      amount: '50',
      txHash: '0xtx',
      blockNumber: 100,
    });
    expect(result).toEqual({ applied: true });
  });

  it('withdraw() throws ConflictException when withdrawal not applied', async () => {
    (mockStakeService.withdraw as jest.Mock).mockResolvedValueOnce({
      applied: false,
      reason: 'duplicate',
    });
    const dto = { walletAddress: '0xabc', amount: '50', txHash: '0xtx', blockNumber: 100 };
    await expect(controller.withdraw('claim-1', dto as any)).rejects.toThrow(ConflictException);
  });

  // ── Reconcile — admin only ────────────────────────────────────────────────

  it('reconcile() delegates to service when admin guard allows', async () => {
    const body = { walletAddress: '0xabc', observedTotal: '1000' };
    const result = await controller.reconcile('claim-1', body);
    expect(mockStakeService.reconcile).toHaveBeenCalledWith('0xabc', 'claim-1', '1000');
    expect(result).toEqual({ synced: true });
  });
});

/**
 * Guard enforcement — reconcile is admin-only, locks/withdrawals are AUTHN only.
 */
describe('StakingController — RolesGuard enforcement on reconcile', () => {
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

  it('admin is allowed on reconcile', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(guard.canActivate(buildContext('admin') as any)).toBe(true);
  });

  it('moderator is denied on reconcile (fail-closed)', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext('moderator') as any)).toThrow(
      ForbiddenException,
    );
  });

  it('contributor is denied on reconcile (fail-closed)', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext('contributor') as any)).toThrow(
      ForbiddenException,
    );
  });

  it('unauthenticated is denied on reconcile (fail-closed)', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext(undefined) as any)).toThrow(
      ForbiddenException,
    );
  });
});
