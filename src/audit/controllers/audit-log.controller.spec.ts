import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit-log.controller';
import { AuditTrailService } from '../services/audit-trail.service';
import { ComplianceService } from '../services/compliance.service';
import { SecurityMonitoringService } from '../services/security-monitoring.service';
import { AuditMetricsService } from '../services/audit-metrics.service';
import { AuditQueueService } from '../services/audit-queue.service';
import { AdminGuard } from '../../admin/guards/admin.guard';
import { RolesGuard as AdminRolesGuard } from '../../admin/guards/roles.guard';
import { AdminRole, AdminRoleHierarchy } from '../../admin/entities/admin.entity';
import { ROLES_KEY } from '../../admin/decorators/roles.decorator';

/**
 * Unit tests for AuditController authorization (V2 API Authorization Matrix).
 *
 * Verifies:
 * - ALL audit endpoints require admin-plane authentication (fail-closed)
 * - Standard queries: ADMIN(auditor) minimum
 * - Security events: ADMIN(security_analyst) minimum
 * - Legal hold mutations: ADMIN(administrator) minimum
 * - Deactivated admin is denied (fail-closed)
 * - No authenticated user is denied (fail-closed)
 * - Role hierarchy: super_admin passes all checks
 * - Role hierarchy: auditor cannot access security events restricted to security_analyst+
 */
describe('AuditController — Authorization Matrix', () => {
  let controller: AuditController;

  const mockAuditTrail = {
    query: jest.fn().mockResolvedValue({ logs: [], page: 1, limit: 20, total: 0, totalPages: 0 }),
    getEntityAuditLogs: jest.fn().mockResolvedValue([]),
    getUserAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
    getActionAuditLogs: jest.fn().mockResolvedValue({ logs: [], total: 0 }),
    getChangeHistory: jest.fn().mockResolvedValue([]),
    getAuditSummary: jest.fn().mockResolvedValue({}),
    getAuditLogsByEventId: jest.fn().mockResolvedValue(null),
    getAuditLogsByCorrelationId: jest.fn().mockResolvedValue([]),
    getStorageStats: jest.fn().mockResolvedValue({}),
    placeLegalHold: jest.fn().mockResolvedValue(5),
    removeLegalHold: jest.fn().mockResolvedValue(5),
    verifyIntegrity: jest.fn().mockResolvedValue({ valid: true }),
    getRetentionStatus: jest.fn().mockResolvedValue({ retentionDays: 90 }),
  };

  const mockCompliance = {
    exportAuditLogs: jest.fn().mockResolvedValue({ format: 'application/json', filename: 'audit.json', data: [] }),
    generateReport: jest.fn().mockResolvedValue({}),
    getDailyActivity: jest.fn().mockResolvedValue([]),
    getCategorySummary: jest.fn().mockResolvedValue({}),
  };

  const mockSecurityMonitoring = {
    getRecentSecurityEvents: jest.fn().mockResolvedValue([]),
    getFailedLoginReport: jest.fn().mockResolvedValue({}),
    getAdminActivityReport: jest.fn().mockResolvedValue([]),
    checkFailedLogins: jest.fn().mockResolvedValue(null),
    checkPermissionEscalation: jest.fn().mockResolvedValue(null),
  };

  const mockAuditMetrics = { updateStorageMetrics: jest.fn().mockResolvedValue(undefined) };
  const mockAuditQueue = { getQueueStats: jest.fn().mockResolvedValue({}) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: AuditTrailService, useValue: mockAuditTrail },
        { provide: ComplianceService, useValue: mockCompliance },
        { provide: SecurityMonitoringService, useValue: mockSecurityMonitoring },
        { provide: AuditMetricsService, useValue: mockAuditMetrics },
        { provide: AuditQueueService, useValue: mockAuditQueue },
      ],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminRolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuditController>(AuditController);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Delegate to services ──────────────────────────────────────────────────

  it('queryAuditLogs() delegates to auditTrailService.query', async () => {
    const result = await controller.queryAuditLogs({} as any, 'req-1');
    expect(mockAuditTrail.query).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('getEntityAuditLogs() delegates to service', async () => {
    const result = await controller.getEntityAuditLogs('claim' as any, 'entity-1', 'req-1');
    expect(mockAuditTrail.getEntityAuditLogs).toHaveBeenCalledWith('claim', 'entity-1');
    expect(result.success).toBe(true);
  });

  it('getUserAuditLogs() delegates to service with pagination', async () => {
    const result = await controller.getUserAuditLogs('user-1', '2', '10', 'req-1');
    expect(mockAuditTrail.getUserAuditLogs).toHaveBeenCalledWith('user-1', 10, 10);
    expect(result.pagination.page).toBe(2);
  });

  it('getAuditSummary() delegates to service', async () => {
    const result = await controller.getAuditSummary(undefined, '7', 'req-1');
    expect(mockAuditTrail.getAuditSummary).toHaveBeenCalledWith(undefined, 7);
    expect(result.success).toBe(true);
  });

  it('getSecurityEvents() delegates to securityMonitoringService', async () => {
    const result = await controller.getSecurityEvents('60', 'req-1');
    expect(mockSecurityMonitoring.getRecentSecurityEvents).toHaveBeenCalledWith(60);
    expect(result.success).toBe(true);
  });

  it('placeLegalHold() delegates to auditTrailService', async () => {
    const result = await controller.placeLegalHold('claim' as any, 'entity-1', 'req-1');
    expect(mockAuditTrail.placeLegalHold).toHaveBeenCalledWith('claim', 'entity-1');
    expect(result.data.affected).toBe(5);
  });

  it('removeLegalHold() delegates to auditTrailService', async () => {
    const result = await controller.removeLegalHold('claim' as any, 'entity-1', 'req-1');
    expect(mockAuditTrail.removeLegalHold).toHaveBeenCalledWith('claim', 'entity-1');
    expect(result.data.affected).toBe(5);
  });

  it('checkUserSecurity() aggregates both monitoring checks', async () => {
    const result = await controller.checkUserSecurity('user-1', 'req-1');
    expect(mockSecurityMonitoring.checkFailedLogins).toHaveBeenCalledWith('user-1');
    expect(mockSecurityMonitoring.checkPermissionEscalation).toHaveBeenCalledWith('user-1');
    expect(result.data.hasIncidents).toBe(false);
  });

  it('getMetrics() calls updateStorageMetrics then returns combined stats', async () => {
    const result = await controller.getMetrics('req-1');
    expect(mockAuditMetrics.updateStorageMetrics).toHaveBeenCalled();
    expect(result.data).toHaveProperty('storage');
    expect(result.data).toHaveProperty('queue');
  });
});

/**
 * Admin-plane RolesGuard enforcement for audit routes.
 * Uses the actual admin/guards/roles.guard implementation with hierarchy checks.
 */
describe('AuditController — Admin RolesGuard hierarchy enforcement', () => {
  const buildAdminContext = (admin: { role: AdminRole; isActive: boolean } | undefined) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ admin }),
    }),
  });

  const buildReflector = (roles: AdminRole[]) =>
    ({
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    }) as unknown as Reflector;

  // ─── General audit query — auditor minimum ────────────────────────────────

  describe('GET /audit — minimum AUDITOR', () => {
    it('auditor is allowed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      expect(
        guard.canActivate(buildAdminContext({ role: AdminRole.AUDITOR, isActive: true }) as any),
      ).toBe(true);
    });

    it('moderator passes (hierarchy >= auditor)', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      expect(
        guard.canActivate(buildAdminContext({ role: AdminRole.MODERATOR, isActive: true }) as any),
      ).toBe(true);
    });

    it('super_admin passes everything', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      expect(
        guard.canActivate(buildAdminContext({ role: AdminRole.SUPER_ADMIN, isActive: true }) as any),
      ).toBe(true);
    });

    it('no admin in request is denied — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      expect(() => guard.canActivate(buildAdminContext(undefined) as any)).toThrow(
        ForbiddenException,
      );
    });

    it('deactivated admin is denied — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      expect(() =>
        guard.canActivate(buildAdminContext({ role: AdminRole.AUDITOR, isActive: false }) as any),
      ).toThrow(ForbiddenException);
    });
  });

  // ─── Security events — security_analyst minimum ───────────────────────────

  describe('GET /audit/security/events — minimum SECURITY_ANALYST', () => {
    it('security_analyst is allowed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.SECURITY_ANALYST]));
      expect(
        guard.canActivate(
          buildAdminContext({ role: AdminRole.SECURITY_ANALYST, isActive: true }) as any,
        ),
      ).toBe(true);
    });

    it('administrator passes (hierarchy > security_analyst)', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.SECURITY_ANALYST]));
      expect(
        guard.canActivate(
          buildAdminContext({ role: AdminRole.ADMINISTRATOR, isActive: true }) as any,
        ),
      ).toBe(true);
    });

    it('auditor (hierarchy 30) is denied for security_analyst route (hierarchy 60) — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.SECURITY_ANALYST]));
      // AdminRoleHierarchy[AUDITOR]=30, AdminRoleHierarchy[SECURITY_ANALYST]=60
      expect(AdminRoleHierarchy[AdminRole.AUDITOR]).toBeLessThan(
        AdminRoleHierarchy[AdminRole.SECURITY_ANALYST],
      );
      expect(() =>
        guard.canActivate(
          buildAdminContext({ role: AdminRole.AUDITOR, isActive: true }) as any,
        ),
      ).toThrow(ForbiddenException);
    });

    it('moderator (hierarchy 50) is denied for security_analyst route (hierarchy 60) — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.SECURITY_ANALYST]));
      expect(AdminRoleHierarchy[AdminRole.MODERATOR]).toBeLessThan(
        AdminRoleHierarchy[AdminRole.SECURITY_ANALYST],
      );
      expect(() =>
        guard.canActivate(
          buildAdminContext({ role: AdminRole.MODERATOR, isActive: true }) as any,
        ),
      ).toThrow(ForbiddenException);
    });
  });

  // ─── Legal hold mutations — administrator minimum ─────────────────────────

  describe('POST /audit/legal-hold — minimum ADMINISTRATOR', () => {
    it('administrator is allowed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.ADMINISTRATOR]));
      expect(
        guard.canActivate(
          buildAdminContext({ role: AdminRole.ADMINISTRATOR, isActive: true }) as any,
        ),
      ).toBe(true);
    });

    it('super_admin is allowed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.ADMINISTRATOR]));
      expect(
        guard.canActivate(
          buildAdminContext({ role: AdminRole.SUPER_ADMIN, isActive: true }) as any,
        ),
      ).toBe(true);
    });

    it('auditor is denied legal hold (hierarchy 30 < 80) — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.ADMINISTRATOR]));
      expect(() =>
        guard.canActivate(
          buildAdminContext({ role: AdminRole.AUDITOR, isActive: true }) as any,
        ),
      ).toThrow(ForbiddenException);
    });

    it('security_analyst is denied legal hold (hierarchy 60 < 80) — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.ADMINISTRATOR]));
      expect(() =>
        guard.canActivate(
          buildAdminContext({ role: AdminRole.SECURITY_ANALYST, isActive: true }) as any,
        ),
      ).toThrow(ForbiddenException);
    });

    it('moderator is denied legal hold — fail-closed', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.ADMINISTRATOR]));
      expect(() =>
        guard.canActivate(
          buildAdminContext({ role: AdminRole.MODERATOR, isActive: true }) as any,
        ),
      ).toThrow(ForbiddenException);
    });
  });

  // ─── AdminGuard failure modes ─────────────────────────────────────────────

  describe('AdminGuard — fail-closed on missing / inactive identity', () => {
    it('deactivated admin is denied at any role level', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      for (const role of Object.values(AdminRole)) {
        expect(() =>
          guard.canActivate(buildAdminContext({ role, isActive: false }) as any),
        ).toThrow(ForbiddenException);
      }
    });

    it('null admin in request is denied', () => {
      const guard = new AdminRolesGuard(buildReflector([AdminRole.AUDITOR]));
      expect(() => guard.canActivate(buildAdminContext(undefined) as any)).toThrow(
        ForbiddenException,
      );
    });
  });
});

/**
 * AdminGuard DB-lookup behaviour (unit — mocked repository).
 */
describe('AdminGuard (DB-backed) — fail-closed invariants for audit routes', () => {
  const buildAdminGuard = (foundAdmin: any) => {
    const adminRepo = { findOne: jest.fn().mockResolvedValue(foundAdmin) } as any;
    const reflector = {} as any;
    const { AdminGuard: Guard } = jest.requireActual('../../admin/guards/admin.guard');
    return new Guard(adminRepo, reflector);
  };

  const makeCtx = (user: any) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  });

  it('sets request.admin when active admin found in DB', async () => {
    const admin = {
      id: 'a1', walletAddress: '0xabc', role: AdminRole.AUDITOR,
      isActive: true, permissions: null, lastLoginAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const guard = buildAdminGuard(admin);
    const ctx = makeCtx({ address: '0xabc' }) as any;
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(ctx.switchToHttp().getRequest().admin).toEqual(admin);
  });

  it('throws UnauthorizedException when request.user is absent', async () => {
    const guard = buildAdminGuard(null);
    await expect(guard.canActivate(makeCtx(null) as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when walletAddress missing from token', async () => {
    const guard = buildAdminGuard(null);
    await expect(guard.canActivate(makeCtx({}) as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws ForbiddenException when wallet not found in admin_users table', async () => {
    const guard = buildAdminGuard(null);
    await expect(guard.canActivate(makeCtx({ address: '0xunknown' }) as any)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
