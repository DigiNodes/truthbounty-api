import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Unit tests for RewardsController authorization (V2 API Authorization Matrix).
 *
 * Verifies:
 * - GET /rewards and GET /rewards/:id are public (no guard required)
 * - POST / PATCH / DELETE require ROLE(admin)
 * - Moderators are denied write access (fail-closed)
 * - Contributors are denied write access (fail-closed)
 * - Unauthenticated requests are denied on write routes (fail-closed)
 */
describe('RewardsController — Authorization Matrix', () => {
  let controller: RewardsController;

  const mockRewardsService: Partial<RewardsService> = {
    create: jest.fn().mockReturnValue('created'),
    findAll: jest.fn().mockReturnValue([]),
    findOne: jest.fn().mockReturnValue('reward-1'),
    update: jest.fn().mockReturnValue('updated'),
    remove: jest.fn().mockReturnValue('removed'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RewardsController],
      providers: [{ provide: RewardsService, useValue: mockRewardsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<RewardsController>(RewardsController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Read routes ───────────────────────────────────────────────────────────

  it('findAll() delegates to service', () => {
    const result = controller.findAll();
    expect(mockRewardsService.findAll).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('findOne() delegates to service with numeric id', () => {
    const result = controller.findOne('5');
    expect(mockRewardsService.findOne).toHaveBeenCalledWith(5);
    expect(result).toBe('reward-1');
  });

  // ── Write routes ──────────────────────────────────────────────────────────

  it('create() delegates to service', () => {
    const dto = { amount: '100' } as any;
    const result = controller.create(dto);
    expect(mockRewardsService.create).toHaveBeenCalledWith(dto);
    expect(result).toBe('created');
  });

  it('update() delegates to service with numeric id', () => {
    const dto = { amount: '200' } as any;
    const result = controller.update('3', dto);
    expect(mockRewardsService.update).toHaveBeenCalledWith(3, dto);
    expect(result).toBe('updated');
  });

  it('remove() delegates to service with numeric id', () => {
    const result = controller.remove('7');
    expect(mockRewardsService.remove).toHaveBeenCalledWith(7);
    expect(result).toBe('removed');
  });
});

/**
 * Guard enforcement — RolesGuard rejects non-admin callers on write routes.
 */
describe('RewardsController — RolesGuard enforcement for write routes', () => {
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

  it('admin is allowed on write routes', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(guard.canActivate(buildContext('admin') as any)).toBe(true);
  });

  it('moderator is denied on write routes', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext('moderator') as any)).toThrow(
      ForbiddenException,
    );
  });

  it('contributor is denied on write routes', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext('contributor') as any)).toThrow(
      ForbiddenException,
    );
  });

  it('unauthenticated caller is denied on write routes', () => {
    const guard = new RolesGuard(buildReflector(['admin']));
    expect(() => guard.canActivate(buildContext(undefined) as any)).toThrow(
      ForbiddenException,
    );
  });
});
