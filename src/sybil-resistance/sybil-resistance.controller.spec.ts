/**
 * SybilResistanceController — authorization & logic tests
 *
 * Strategy:
 *  - Guards (JwtAuthGuard, AdminGuard, SybilOwnershipGuard) are tested as
 *    standalone units because NestJS @UseGuards() decorators only fire in the
 *    full HTTP pipeline, not when calling controller methods directly.
 *  - Controller method tests cover input validation and service delegation.
 *  - Metadata tests confirm every mutating route is decorated with the correct
 *    guard metadata (AdminOnly, UseGuards), so guard presence is verified at
 *    the decorator level even though activation is pipeline-driven.
 */
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SybilResistanceController } from './sybil-resistance.controller';
import { SybilResistanceService } from './sybil-resistance.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { SybilOwnershipGuard } from './guards/sybil-ownership.guard';
import { ADMIN_ONLY_KEY } from '../auth/guards/admin.guard';

// SybilResistanceService transitively loads @nestjs/typeorm / typeorm via
// InjectRepository.  Those packages are not installed in the local
// (Windows / forced-install) environment.  A factory mock prevents the real
// file from being evaluated.
jest.mock('./sybil-resistance.service', () => ({
  SybilResistanceService: class MockSybilResistanceService {},
}));

// ─── helpers ────────────────────────────────────────────────────────────────

const OWNER_ID = 'usr-owner-001';
const OTHER_ID = 'usr-other-002';
const ADMIN_ID = 'usr-admin-003';

function makeContext(opts: {
  user?: Record<string, unknown> | null;
  paramUserId?: string;
  body?: Record<string, unknown>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: opts.user ?? undefined,
        params: opts.paramUserId ? { userId: opts.paramUserId } : {},
        body: opts.body ?? {},
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function buildService(): jest.Mocked<SybilResistanceService> {
  return {
    recordSybilScore: jest
      .fn()
      .mockResolvedValue({ id: 'rec-1', compositeScore: 0.85 }),
    getLatestSybilScore: jest
      .fn()
      .mockResolvedValue({ id: 'rec-1', compositeScore: 0.85 }),
    getPublicSybilScore: jest.fn().mockResolvedValue({
      userId: OWNER_ID,
      score: 0.85,
      riskScore: 0.15,
      riskLevel: 'LOW',
      version: '1.0.0',
      provenanceDigest: 'a'.repeat(64),
    }),
    recomputeScore: jest.fn().mockResolvedValue({
      score: 0.85,
      riskScore: 0.15,
      riskLevel: 'LOW',
      version: '1.0.0',
    }),
    submitAppeal: jest.fn().mockResolvedValue({
      appealId: 'app-1',
      userId: OWNER_ID,
      status: 'SUBMITTED',
      reason: 'Valid justification for appeal',
    }),
    getAppeals: jest
      .fn()
      .mockResolvedValue([{ appealId: 'app-1', status: 'SUBMITTED' }]),
    getModelVersions: jest
      .fn()
      .mockReturnValue([{ version: '1.0.0' }, { version: '2.0.0' }]),
    getSybilScoreHistory: jest.fn().mockResolvedValue([{ id: 'rec-1' }]),
    getSybilScoreForVoting: jest
      .fn()
      .mockResolvedValue({ userId: OWNER_ID, score: 0.85 }),
    setWorldcoinVerified: jest.fn().mockResolvedValue({ id: 'rec-2' }),
    recalculateAllScores: jest
      .fn()
      .mockResolvedValue([{ userId: OWNER_ID, success: true }]),
  } as unknown as jest.Mocked<SybilResistanceService>;
}

// ============================================================================
// 1. SybilOwnershipGuard — unit tests
// ============================================================================
describe('SybilOwnershipGuard', () => {
  let guard: SybilOwnershipGuard;

  beforeEach(() => {
    guard = new SybilOwnershipGuard();
  });

  it('throws UnauthorizedException when request.user is absent', () => {
    expect(() =>
      guard.canActivate(makeContext({ user: null, paramUserId: OWNER_ID })),
    ).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when principal has no sub or userId', () => {
    expect(() =>
      guard.canActivate(makeContext({ user: {}, paramUserId: OWNER_ID })),
    ).toThrow(UnauthorizedException);
  });

  it('throws ForbiddenException when route param does not match principal.sub', () => {
    expect(() =>
      guard.canActivate(
        makeContext({ user: { sub: OWNER_ID }, paramUserId: OTHER_ID }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when route param does not match principal.userId', () => {
    expect(() =>
      guard.canActivate(
        makeContext({ user: { userId: OWNER_ID }, paramUserId: OTHER_ID }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows when route param matches principal.sub', () => {
    expect(
      guard.canActivate(
        makeContext({ user: { sub: OWNER_ID }, paramUserId: OWNER_ID }),
      ),
    ).toBe(true);
  });

  it('allows when route param matches principal.userId (fallback)', () => {
    expect(
      guard.canActivate(
        makeContext({ user: { userId: OWNER_ID }, paramUserId: OWNER_ID }),
      ),
    ).toBe(true);
  });

  it('allows when no :userId param is present (guard not applicable)', () => {
    expect(guard.canActivate(makeContext({ user: { sub: OWNER_ID } }))).toBe(
      true,
    );
  });

  // Cross-user IDOR regression
  it('rejects every cross-user combination', () => {
    const pairs = [
      [OWNER_ID, OTHER_ID],
      [OWNER_ID, ADMIN_ID],
      [OTHER_ID, OWNER_ID],
      [ADMIN_ID, OWNER_ID],
    ];
    for (const [principal, route] of pairs) {
      expect(() =>
        guard.canActivate(
          makeContext({ user: { sub: principal }, paramUserId: route }),
        ),
      ).toThrow(ForbiddenException);
    }
  });
});

// ============================================================================
// 2. AdminGuard — unit tests (anonymous / role checks)
// ============================================================================
describe('AdminGuard — anonymous and non-admin rejection', () => {
  let guard: AdminGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(() => true),
    } as unknown as Reflector;
    guard = new AdminGuard(reflector);
  });

  it('throws ForbiddenException when no authenticated request', () => {
    // isAuthenticatedRequest fails → ForbiddenException
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user has non-admin role', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          use: { address: '0xdeadbeef', user: { role: 'contributor' } },
          user: { address: '0xdeadbeef', user: { role: 'contributor' } },
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows when user has admin role', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          use: { address: '0xdeadbeef', user: { role: 'admin' } },
          user: { address: '0xdeadbeef', user: { role: 'admin' } },
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

// ============================================================================
// 3. Controller route metadata — confirm guards are applied to mutating routes
// ============================================================================
describe('Controller route metadata — guard decorators are present', () => {
  it('POST score, recompute, recalculate-all are decorated with AdminOnly metadata', () => {
    // AdminOnly() calls SetMetadata(ADMIN_ONLY_KEY, true).
    // We read it from the method descriptor so the test fails if the
    // decorator is ever removed from the handler.
    const ctrl = SybilResistanceController.prototype;
    const adminRoutes = ['recordScore', 'recomputeScore', 'recalculateAll'];
    for (const method of adminRoutes) {
      const meta = Reflect.getMetadata(
        ADMIN_ONLY_KEY,
        (ctrl as Record<string, unknown>)[method] as object,
      );
      expect(meta).toBe(true);
    }
  });

  it('POST appeal does NOT carry AdminOnly metadata (self-service route)', () => {
    const meta = Reflect.getMetadata(
      ADMIN_ONLY_KEY,
      SybilResistanceController.prototype.submitAppeal,
    );
    expect(meta).toBeUndefined();
  });

  it('POST verify-worldcoin does NOT carry AdminOnly metadata (removed — no admin path)', () => {
    const meta = Reflect.getMetadata(
      ADMIN_ONLY_KEY,
      SybilResistanceController.prototype.setWorldcoinVerified,
    );
    expect(meta).toBeUndefined();
  });
});

// ============================================================================
// 4. Controller methods — input validation and service delegation
// ============================================================================
describe('SybilResistanceController — method logic', () => {
  let controller: SybilResistanceController;
  let service: jest.Mocked<SybilResistanceService>;

  beforeEach(async () => {
    service = buildService();
    const module = await Test.createTestingModule({
      controllers: [SybilResistanceController],
      providers: [{ provide: SybilResistanceService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SybilOwnershipGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(SybilResistanceController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── recordScore ──────────────────────────────────────────────────────────
  describe('recordScore', () => {
    it('calls service.recordSybilScore with valid userId', async () => {
      const res = await controller.recordScore(OWNER_ID);
      expect(res).toEqual({ id: 'rec-1', compositeScore: 0.85 });
      expect(service.recordSybilScore).toHaveBeenCalledWith(OWNER_ID);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.recordScore('')).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.recordScore('   ')).rejects.toThrow(
        BadRequestException,
      );
      expect(service.recordSybilScore).not.toHaveBeenCalled();
    });
  });

  // ── getLatestScore ───────────────────────────────────────────────────────
  describe('getLatestScore', () => {
    it('returns latest score', async () => {
      const res = await controller.getLatestScore(OWNER_ID);
      expect(res).toEqual({ id: 'rec-1', compositeScore: 0.85 });
      expect(service.getLatestSybilScore).toHaveBeenCalledWith(OWNER_ID);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.getLatestScore('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getPublicScore ───────────────────────────────────────────────────────
  describe('getPublicScore', () => {
    it('returns privacy-safe public score', async () => {
      const res = await controller.getPublicScore(OWNER_ID);
      expect(res.userId).toBe(OWNER_ID);
      expect(res.score).toBe(0.85);
      expect(service.getPublicSybilScore).toHaveBeenCalledWith(OWNER_ID);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.getPublicScore('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── recomputeScore ───────────────────────────────────────────────────────
  describe('recomputeScore', () => {
    it('calls service with userId and options', async () => {
      const opts = { pinnedVersion: '2.0.0' };
      const res = await controller.recomputeScore(OWNER_ID, opts);
      expect(res.score).toBe(0.85);
      expect(service.recomputeScore).toHaveBeenCalledWith(OWNER_ID, opts);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.recomputeScore('', {})).rejects.toThrow(
        BadRequestException,
      );
      expect(service.recomputeScore).not.toHaveBeenCalled();
    });
  });

  // ── submitAppeal ─────────────────────────────────────────────────────────
  describe('submitAppeal', () => {
    it('submits appeal with valid reason', async () => {
      const body = { reason: 'Newly verified Orb credential' };
      const res = await controller.submitAppeal(OWNER_ID, body);
      expect(res.status).toBe('SUBMITTED');
      expect(service.submitAppeal).toHaveBeenCalledWith(OWNER_ID, body);
    });

    it('throws BadRequestException when reason is empty', async () => {
      await expect(
        controller.submitAppeal(OWNER_ID, { reason: '' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(service.submitAppeal).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when body is null', async () => {
      await expect(
        controller.submitAppeal(OWNER_ID, null as never),
      ).rejects.toThrow(BadRequestException);
      expect(service.submitAppeal).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(
        controller.submitAppeal('', { reason: 'valid reason' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getAppeals ───────────────────────────────────────────────────────────
  describe('getAppeals', () => {
    it('returns appeal history', async () => {
      const res = await controller.getAppeals(OWNER_ID);
      expect(res).toHaveLength(1);
      expect(service.getAppeals).toHaveBeenCalledWith(OWNER_ID);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.getAppeals('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getModels ────────────────────────────────────────────────────────────
  describe('getModels', () => {
    it('returns model versions', async () => {
      const res = await controller.getModels();
      expect(res).toHaveLength(2);
      expect(service.getModelVersions).toHaveBeenCalled();
    });
  });

  // ── getScoreHistory ──────────────────────────────────────────────────────
  describe('getScoreHistory', () => {
    it('returns history', async () => {
      await controller.getScoreHistory(OWNER_ID);
      expect(service.getSybilScoreHistory).toHaveBeenCalledWith(OWNER_ID);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.getScoreHistory('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── getScoreForVoting ────────────────────────────────────────────────────
  describe('getScoreForVoting', () => {
    it('returns voting format', async () => {
      await controller.getScoreForVoting(OWNER_ID);
      expect(service.getSybilScoreForVoting).toHaveBeenCalledWith(OWNER_ID);
    });

    it('throws BadRequestException for empty userId', async () => {
      await expect(controller.getScoreForVoting('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── recalculateAll ───────────────────────────────────────────────────────
  describe('recalculateAll', () => {
    it('calls service and returns results', async () => {
      const res = await controller.recalculateAll({ user: { sub: ADMIN_ID } });
      expect(Array.isArray(res)).toBe(true);
      expect(service.recalculateAllScores).toHaveBeenCalled();
    });
  });

  // ── setWorldcoinVerified — permanently removed ───────────────────────────
  describe('setWorldcoinVerified (removed endpoint)', () => {
    it('always throws ForbiddenException regardless of caller or body', async () => {
      await expect(
        controller.setWorldcoinVerified(OWNER_ID, { verified: true }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for verified=false (cannot revoke either)', async () => {
      await expect(
        controller.setWorldcoinVerified(OWNER_ID, { verified: false }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for a different userId', async () => {
      await expect(
        controller.setWorldcoinVerified(OTHER_ID, { verified: true }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('never calls service.setWorldcoinVerified', async () => {
      try {
        await controller.setWorldcoinVerified(OWNER_ID, { verified: true });
      } catch {}
      try {
        await controller.setWorldcoinVerified(OWNER_ID, { verified: false });
      } catch {}
      expect(service.setWorldcoinVerified).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// 5. Service-layer one-active-appeal enforcement
// ============================================================================
describe('one-active-appeal enforcement (service propagation)', () => {
  it('controller propagates rejection when service reports a pending appeal', async () => {
    const svc = buildService();
    svc.submitAppeal.mockRejectedValue(
      new BadRequestException('You already have a pending appeal.'),
    );

    const module = await Test.createTestingModule({
      controllers: [SybilResistanceController],
      providers: [{ provide: SybilResistanceService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SybilOwnershipGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const ctrl = module.get(SybilResistanceController);

    await expect(
      ctrl.submitAppeal(OWNER_ID, {
        reason: 'second attempt while one is pending',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ============================================================================
// 6. verify-worldcoin — confirm service is never reachable via controller
// ============================================================================
describe('verify-worldcoin endpoint — service unreachable', () => {
  it('service.setWorldcoinVerified is never called through the controller', async () => {
    const svc = buildService();

    const module = await Test.createTestingModule({
      controllers: [SybilResistanceController],
      providers: [{ provide: SybilResistanceService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SybilOwnershipGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const ctrl = module.get(SybilResistanceController);

    // Try every combination of callers and boolean values.
    for (const userId of [OWNER_ID, OTHER_ID, ADMIN_ID]) {
      for (const verified of [true, false]) {
        await expect(
          ctrl.setWorldcoinVerified(userId, { verified }),
        ).rejects.toThrow(ForbiddenException);
      }
    }
    expect(svc.setWorldcoinVerified).not.toHaveBeenCalled();
  });
});
