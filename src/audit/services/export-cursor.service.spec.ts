/**
 * PREWAVE-BE-033 — Cursor-based audit export
 * Unit + integration tests
 *
 * Scenarios covered:
 *   1. Unauthorized (no token, wrong role, wrong owner)
 *   2. Large export (multi-page, row / page limit enforcement)
 *   3. Concurrent append (rows added between pages do not cause skips/duplicates)
 *   4. Tampered checkpoint (HMAC mismatch detected by caller)
 *   5. Cancellation (cursor transitions to 'cancelled'; further fetch rejected)
 *   6. Expired cursor (cursor past expiresAt rejected)
 *   7. Injection (malicious filter values sanitised via parameterised query)
 *
 * Guard scenarios:
 *   A. Missing user → 401
 *   B. Non-admin user → 403
 *   C. Admin below AUDITOR role → 403
 *   D. Cursor belongs to different requester → 403
 *   E. Cursor status !== active → 403
 *   F. Cursor past expiresAt → 403
 *
 * Service invariants:
 *   - Export cannot mutate records (all SELECT queries)
 *   - Sensitive fields excluded (allowlist enforced)
 *   - Integrity independently verifiable (checkpointHash)
 *   - Work bounded (page size, row total, page count, time limit)
 */

import {
  ForbiddenException,
  GoneException,
  NotFoundException,
  RequestTimeoutException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { AuditLog, AuditActionType, AuditEntityType, AuditSeverity, AuditCategory } from '../entities/audit-log.entity';
import { ExportCursor } from '../entities/export-cursor.entity';
import { ExportCursorService } from '../services/export-cursor.service';
import { AuditExportCapabilityGuard } from '../guards/audit-export-capability.guard';
import { Admin, AdminRole } from '../../admin/entities/admin.entity';
import {
  ExportAuditCursorDto,
  EXPORT_PAGE_SIZE_MAX,
  EXPORT_ROW_LIMIT_TOTAL,
  EXPORT_PAGE_LIMIT,
  EXPORT_FIELD_ALLOWLIST,
  EXPORT_TIME_LIMIT_MS,
} from '../dto/export-audit-cursor.dto';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-audit-hash-secret-32-chars!!';

function makeAuditLog(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'log-' + Math.random().toString(36).slice(2),
    eventId: 'evt-' + Math.random().toString(36).slice(2),
    actionType: AuditActionType.CLAIM_CREATED,
    entityType: AuditEntityType.CLAIM,
    entityId: 'claim-1',
    userId: 'user-1',
    walletAddress: '0xSECRET',
    severity: AuditSeverity.LOW,
    category: AuditCategory.OPERATIONS,
    source: 'test',
    requestId: 'req-1',
    description: 'test event',
    beforeState: { secret: 'SHOULD_BE_EXCLUDED' },
    afterState: { secret: 'SHOULD_BE_EXCLUDED' },
    metadata: { internal: 'SHOULD_BE_EXCLUDED' },
    ipAddress: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    correlationId: 'corr-1',
    retentionUntil: null,
    integrityHash: 'hash-abc',
    previousHash: null,
    chainSequence: 1,
    archived: false,
    user: null,
    ...overrides,
  } as AuditLog;
}

function makeExportCursor(overrides: Partial<ExportCursor> = {}): ExportCursor {
  return {
    id: 'cursor-' + Math.random().toString(36).slice(2),
    requesterId: 'admin-1',
    status: 'active',
    filters: {},
    lastSeq: 0,
    lastId: null,
    pagesFetched: 0,
    rowsExported: 0,
    checkpointHash: null,
    format: 'json',
    exportVersion: '1',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  } as ExportCursor;
}

function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    id: 'admin-1',
    walletAddress: '0xadmin',
    role: AdminRole.AUDITOR,
    isActive: true,
    permissions: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Admin;
}

// ─── Mock repository factory ───────────────────────────────────────────────

function mockRepo<T>() {
  const repo = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: any) => x),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
  // Default QB
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  };
  repo.createQueryBuilder.mockReturnValue(qb);
  return { repo, qb };
}

// ─── ExportCursorService unit tests ──────────────────────────────────────────

describe('ExportCursorService', () => {
  let service: ExportCursorService;
  let auditLogRepoMock: ReturnType<typeof mockRepo>['repo'];
  let exportCursorRepoMock: ReturnType<typeof mockRepo>['repo'];
  let auditLogQbMock: ReturnType<typeof mockRepo>['qb'];

  const configStub: Partial<ConfigService> = {
    get: jest.fn((key: string) => {
      if (key === 'AUDIT_HASH_SECRET') return TEST_SECRET;
      if (key === 'NODE_ENV') return 'test';
      return undefined;
    }),
  };

  beforeEach(async () => {
    const { repo: alRepo, qb: alQb } = mockRepo<AuditLog>();
    const { repo: ecRepo } = mockRepo<ExportCursor>();

    auditLogRepoMock = alRepo;
    exportCursorRepoMock = ecRepo;
    auditLogQbMock = alQb;

    // auditLogRepo.createQueryBuilder returns our audit log QB
    auditLogRepoMock.createQueryBuilder.mockReturnValue(auditLogQbMock);

    // ExportCursor QB used in expireStalecursors
    const ecQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    exportCursorRepoMock.createQueryBuilder.mockReturnValue(ecQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportCursorService,
        { provide: getRepositoryToken(AuditLog), useValue: auditLogRepoMock },
        { provide: getRepositoryToken(ExportCursor), useValue: exportCursorRepoMock },
        { provide: ConfigService, useValue: configStub },
      ],
    }).compile();

    service = module.get<ExportCursorService>(ExportCursorService);
  });

  // ── Scenario 1: Unauthorized ───────────────────────────────────────────────

  describe('unauthorized access', () => {
    it('should reject cursor resume when requesterId does not match cursor owner', async () => {
      const cursor = makeExportCursor({ requesterId: 'owner-A' });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'attacker-B'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject cursor resume when cursor is not found', async () => {
      exportCursorRepoMock.findOne.mockResolvedValue(null);

      await expect(
        service.fetchPage({ cursorId: 'ghost-cursor' }, 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Scenario 2: Large export ───────────────────────────────────────────────

  describe('large export limits', () => {
    it('should reject when rowsExported already >= EXPORT_ROW_LIMIT_TOTAL', async () => {
      const cursor = makeExportCursor({ rowsExported: EXPORT_ROW_LIMIT_TOTAL });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'admin-1'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should reject when pagesFetched already >= EXPORT_PAGE_LIMIT', async () => {
      const cursor = makeExportCursor({ pagesFetched: EXPORT_PAGE_LIMIT });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'admin-1'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should clamp requested limit to EXPORT_PAGE_SIZE_MAX', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });
      auditLogQbMock.getMany.mockResolvedValue([]);

      const oversized = EXPORT_PAGE_SIZE_MAX + 999;
      await service.fetchPage({ limit: oversized }, 'admin-1');

      // The QB .take() must be called with at most EXPORT_PAGE_SIZE_MAX
      expect(auditLogQbMock.take).toHaveBeenCalledWith(EXPORT_PAGE_SIZE_MAX);
    });
  });

  // ── Scenario 3: Concurrent append ─────────────────────────────────────────

  describe('concurrent append', () => {
    it('should use chainSequence keyset so new rows do not cause skips', async () => {
      // Simulate cursor already at lastSeq=5; new page should only fetch seq>5
      const cursor = makeExportCursor({ lastSeq: 5, lastId: 'log-5' });
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      const newRows = [
        makeAuditLog({ chainSequence: 6, id: 'log-6' }),
        makeAuditLog({ chainSequence: 7, id: 'log-7' }),
      ];
      auditLogQbMock.getMany.mockResolvedValue(newRows);

      const result = await service.fetchPage({ cursorId: cursor.id }, 'admin-1');

      // The QB must filter chainSequence > lastSeq
      expect(auditLogQbMock.where).toHaveBeenCalledWith(
        expect.stringContaining('al.chainSequence > :lastSeq'),
        expect.objectContaining({ lastSeq: 5 }),
      );

      // Cursor updated to lastSeq of last returned row
      expect(exportCursorRepoMock.update).toHaveBeenCalledWith(
        cursor.id,
        expect.objectContaining({ lastSeq: 7, lastId: 'log-7' }),
      );

      expect(result.meta.pageCount).toBe(2);
    });
  });

  // ── Scenario 4: Tampered checkpoint ───────────────────────────────────────

  describe('tampered checkpoint detection', () => {
    it('should produce a verifiable HMAC-SHA256 checkpointHash over the page rows', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      const rows = [makeAuditLog({ chainSequence: 1 })];
      auditLogQbMock.getMany.mockResolvedValue(rows);

      const result = await service.fetchPage({}, 'admin-1');

      // Caller independently verifies the hash
      const serialised = JSON.stringify(result.data!);
      const expected = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(serialised)
        .digest('hex');

      expect(result.meta.checkpointHash).toBe(expected);
    });

    it('should detect tampering when a row is altered after export', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      const rows = [makeAuditLog({ chainSequence: 1, description: 'original' })];
      auditLogQbMock.getMany.mockResolvedValue(rows);

      const result = await service.fetchPage({}, 'admin-1');
      const originalHash = result.meta.checkpointHash;

      // Simulate tampered data arriving at the caller
      const tampered = result.data!.map((r) => ({
        ...r,
        description: 'tampered',
      }));
      const computedHash = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(JSON.stringify(tampered))
        .digest('hex');

      expect(computedHash).not.toBe(originalHash);
    });
  });

  // ── Scenario 5: Cancellation ───────────────────────────────────────────────

  describe('cancellation', () => {
    it('should transition an active cursor to cancelled', async () => {
      const cursor = makeExportCursor({ status: 'active' });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      await service.cancelCursor(cursor.id, cursor.requesterId);

      expect(exportCursorRepoMock.update).toHaveBeenCalledWith(
        cursor.id,
        { status: 'cancelled' },
      );
    });

    it('should reject fetchPage on a cancelled cursor', async () => {
      const cursor = makeExportCursor({ status: 'cancelled' });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'admin-1'),
      ).rejects.toThrow(GoneException);
    });

    it('should not cancel a cursor owned by another requester', async () => {
      const cursor = makeExportCursor({ requesterId: 'owner-A' });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.cancelCursor(cursor.id, 'attacker-B'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── Scenario 6: Expired cursor ─────────────────────────────────────────────

  describe('expired cursor', () => {
    it('should reject fetchPage when cursor expiresAt is in the past', async () => {
      const cursor = makeExportCursor({
        expiresAt: new Date(Date.now() - 1_000),
        status: 'active',
      });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'admin-1'),
      ).rejects.toThrow(GoneException);
    });

    it('should reject fetchPage when cursor status === expired', async () => {
      const cursor = makeExportCursor({ status: 'expired' });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'admin-1'),
      ).rejects.toThrow(GoneException);
    });

    it('should mark stale cursors as expired via expireStalecursors()', async () => {
      const affected = await service.expireStalecursors();
      // The mock QB execute returns { affected: 2 }
      expect(affected).toBe(2);
    });
  });

  // ── Scenario 7: Injection ─────────────────────────────────────────────────

  describe('injection prevention', () => {
    it('should use parameterised bindings for all filter values when resuming a cursor', async () => {
      // Set up a cursor that has stored a malicious userId filter
      const maliciousUserId = "' OR 1=1 --";
      const cursor = makeExportCursor({
        filters: {
          userId: maliciousUserId,
          entityType: AuditEntityType.CLAIM,
        },
      });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });
      auditLogQbMock.getMany.mockResolvedValue([]);

      await service.fetchPage({ cursorId: cursor.id }, 'admin-1');

      // andWhere must be called with an object containing the userId, not interpolated into the string
      const andWhereCalls: Array<[string, Record<string, unknown>]> = auditLogQbMock.andWhere.mock.calls;
      const userIdCall = andWhereCalls.find(([_sql, params]) => params && 'userId' in params);
      expect(userIdCall).toBeDefined();
      expect(userIdCall![1]['userId']).toBe(maliciousUserId);
      // The SQL fragment must use a bind variable, not the literal value
      expect(userIdCall![0]).toContain(':userId');
      expect(userIdCall![0]).not.toContain(maliciousUserId);
    });
  });

  // ── Sensitive field exclusion (allowlist) ─────────────────────────────────

  describe('sensitive field exclusion', () => {
    const SENSITIVE_FIELDS = [
      'beforeState',
      'afterState',
      'metadata',
      'ipAddress',
      'userAgent',
      'walletAddress',
    ];

    it('should exclude all sensitive fields from export output', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      const row = makeAuditLog({ chainSequence: 1 });
      auditLogQbMock.getMany.mockResolvedValue([row]);

      const result = await service.fetchPage({}, 'admin-1');
      expect(result.data).not.toBeNull();

      for (const field of SENSITIVE_FIELDS) {
        expect(result.data![0]).not.toHaveProperty(field);
      }
    });

    it('should only include fields in EXPORT_FIELD_ALLOWLIST', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      const row = makeAuditLog({ chainSequence: 1 });
      auditLogQbMock.getMany.mockResolvedValue([row]);

      const result = await service.fetchPage({}, 'admin-1');
      const returnedKeys = Object.keys(result.data![0]);
      for (const key of returnedKeys) {
        expect(EXPORT_FIELD_ALLOWLIST).toContain(key);
      }
    });
  });

  // ── Export immutability ───────────────────────────────────────────────────

  describe('export immutability', () => {
    it('should never call repository mutating methods (save/insert/delete) on AuditLog', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });
      auditLogQbMock.getMany.mockResolvedValue([makeAuditLog()]);

      await service.fetchPage({}, 'admin-1');

      // AuditLog repository must never have write methods called on it
      expect(auditLogRepoMock.save).not.toHaveBeenCalled();
      // The QB used for audit logs should only use SELECT operations (getMany/getOne)
      // It should not have had set() called, which indicates an UPDATE QB
      expect(auditLogQbMock.set).not.toHaveBeenCalled();
    });
  });

  // ── Time limit ────────────────────────────────────────────────────────────

  describe('time limit enforcement', () => {
    it('should reject page fetch with RequestTimeoutException when query exceeds limit', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });

      // Simulate a slow query that never resolves within the test
      auditLogQbMock.getMany.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(resolve, EXPORT_TIME_LIMIT_MS + 5_000),
          ),
      );

      await expect(service.fetchPage({}, 'admin-1')).rejects.toThrow(
        RequestTimeoutException,
      );
    }, EXPORT_TIME_LIMIT_MS + 2_000);
  });

  // ── CSV format ────────────────────────────────────────────────────────────

  describe('CSV format', () => {
    it('should return csv string and null data when format = csv', async () => {
      const cursor = makeExportCursor({ format: 'csv' });
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });
      auditLogQbMock.getMany.mockResolvedValue([makeAuditLog({ chainSequence: 1 })]);

      const result = await service.fetchPage({ format: 'csv' }, 'admin-1');

      expect(result.data).toBeNull();
      expect(typeof result.csv).toBe('string');
      expect(result.csv).toContain('eventId'); // header row
    });
  });

  // ── Exhausted cursor ─────────────────────────────────────────────────────

  describe('exhausted cursor', () => {
    it('should set status to exhausted when fewer rows than limit are returned', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });
      auditLogQbMock.getMany.mockResolvedValue([makeAuditLog({ chainSequence: 1 })]);

      const result = await service.fetchPage({ limit: 100 }, 'admin-1');

      expect(result.meta.exhausted).toBe(true);
      expect(result.meta.status).toBe('exhausted');
      expect(exportCursorRepoMock.update).toHaveBeenCalledWith(
        cursor.id,
        expect.objectContaining({ status: 'exhausted' }),
      );
    });

    it('should reject further fetch on an exhausted cursor', async () => {
      const cursor = makeExportCursor({ status: 'exhausted' });
      exportCursorRepoMock.findOne.mockResolvedValue(cursor);

      await expect(
        service.fetchPage({ cursorId: cursor.id }, 'admin-1'),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  // ── Response metadata completeness ───────────────────────────────────────

  describe('response metadata', () => {
    it('should include all required meta fields in the response', async () => {
      const cursor = makeExportCursor();
      exportCursorRepoMock.save.mockResolvedValue(cursor);
      exportCursorRepoMock.update.mockResolvedValue({ affected: 1 });
      auditLogQbMock.getMany.mockResolvedValue([]);

      const result = await service.fetchPage({}, 'admin-1');

      expect(result.meta).toMatchObject({
        cursorId: expect.any(String),
        status: expect.stringMatching(/^(active|exhausted)$/),
        pageCount: expect.any(Number),
        totalExported: expect.any(Number),
        pagesFetched: expect.any(Number),
        exhausted: expect.any(Boolean),
        checkpointHash: expect.any(String),
        exportVersion: '1',
        format: 'json',
        expiresAt: expect.any(String),
        elapsedMs: expect.any(Number),
      });
      expect(result.success).toBe(true);
      expect(result.timestamp).toBeTruthy();
    });
  });
});

// ─── AuditExportCapabilityGuard unit tests ────────────────────────────────────

describe('AuditExportCapabilityGuard', () => {
  let guard: AuditExportCapabilityGuard;
  let adminRepoMock: ReturnType<typeof mockRepo>['repo'];
  let exportCursorRepoMock: ReturnType<typeof mockRepo>['repo'];

  function buildContext(
    overrides: {
      user?: any;
      queryParams?: Record<string, string>;
    } = {},
  ) {
    const request: any = {
      user: overrides.user ?? { address: '0xadmin' },
      query: overrides.queryParams ?? {},
      body: {},
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as any;
  }

  beforeEach(async () => {
    const { repo: aRepo } = mockRepo<Admin>();
    const { repo: ecRepo } = mockRepo<ExportCursor>();

    adminRepoMock = aRepo;
    exportCursorRepoMock = ecRepo;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditExportCapabilityGuard,
        { provide: getRepositoryToken(Admin), useValue: adminRepoMock },
        { provide: getRepositoryToken(ExportCursor), useValue: exportCursorRepoMock },
        { provide: 'Reflector', useValue: { getAllAndOverride: jest.fn() } },
      ],
    }).compile();

    guard = module.get<AuditExportCapabilityGuard>(AuditExportCapabilityGuard);
  });

  // ── Guard scenario A: Missing user ────────────────────────────────────────

  it('A: should throw UnauthorizedException when no user on request', async () => {
    const ctx = buildContext({ user: null });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── Guard scenario B: Non-admin user ─────────────────────────────────────

  it('B: should throw ForbiddenException when admin record not found', async () => {
    adminRepoMock.findOne.mockResolvedValue(null);
    const ctx = buildContext({ user: { address: '0xnobody' } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ── Guard scenario C: Admin below AUDITOR role ────────────────────────────

  it('C: should throw ForbiddenException for admin with MODERATOR role (below AUDITOR)', async () => {
    adminRepoMock.findOne.mockResolvedValue(
      makeAdmin({ role: AdminRole.MODERATOR }),
    );
    const ctx = buildContext();
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ── Guard scenario D: Cursor belongs to different requester ───────────────

  it('D: should throw ForbiddenException when cursor belongs to a different requester', async () => {
    const admin = makeAdmin({ id: 'requester-X', role: AdminRole.AUDITOR });
    adminRepoMock.findOne.mockResolvedValue(admin);

    const cursor = makeExportCursor({ requesterId: 'requester-Y', status: 'active' });
    exportCursorRepoMock.findOne.mockResolvedValue(cursor);

    const ctx = buildContext({
      queryParams: { cursorId: cursor.id },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ── Guard scenario E: Cursor status !== active ────────────────────────────

  it('E: should throw ForbiddenException when cursor status is cancelled', async () => {
    const admin = makeAdmin({ id: 'admin-1', role: AdminRole.AUDITOR });
    adminRepoMock.findOne.mockResolvedValue(admin);

    const cursor = makeExportCursor({ requesterId: 'admin-1', status: 'cancelled' });
    exportCursorRepoMock.findOne.mockResolvedValue(cursor);

    const ctx = buildContext({ queryParams: { cursorId: cursor.id } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ── Guard scenario F: Cursor past expiresAt ───────────────────────────────

  it('F: should throw ForbiddenException when cursor expiresAt has passed', async () => {
    const admin = makeAdmin({ id: 'admin-1', role: AdminRole.AUDITOR });
    adminRepoMock.findOne.mockResolvedValue(admin);

    const cursor = makeExportCursor({
      requesterId: 'admin-1',
      status: 'active',
      expiresAt: new Date(Date.now() - 1),
    });
    exportCursorRepoMock.findOne.mockResolvedValue(cursor);

    const ctx = buildContext({ queryParams: { cursorId: cursor.id } });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ── Happy path: AUDITOR + active cursor ───────────────────────────────────

  it('should allow AUDITOR with active cursor through', async () => {
    const admin = makeAdmin({ id: 'admin-1', role: AdminRole.AUDITOR });
    adminRepoMock.findOne.mockResolvedValue(admin);

    const cursor = makeExportCursor({ requesterId: 'admin-1', status: 'active' });
    exportCursorRepoMock.findOne.mockResolvedValue(cursor);

    const ctx = buildContext({ queryParams: { cursorId: cursor.id } });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should allow SUPER_ADMIN without a cursor through', async () => {
    const admin = makeAdmin({ role: AdminRole.SUPER_ADMIN });
    adminRepoMock.findOne.mockResolvedValue(admin);

    const ctx = buildContext();
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });
});
