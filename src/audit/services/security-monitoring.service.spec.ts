import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SecurityMonitoringService } from './security-monitoring.service';
import { AuditLog, AuditActionType, AuditEntityType, AuditSeverity, AuditCategory } from '../entities/audit-log.entity';
import { Repository } from 'typeorm';

describe('SecurityMonitoringService', () => {
  let service: SecurityMonitoringService;
  let repository: jest.Mocked<Repository<AuditLog>>;

  const mockAuditLog = (overrides: Partial<AuditLog> = {}): AuditLog => ({
    id: 'audit-1',
    eventId: 'evt-1',
    actionType: AuditActionType.LOGIN_FAILED,
    entityType: AuditEntityType.USER,
    entityId: 'user-1',
    userId: 'user-1',
    walletAddress: null,
    severity: AuditSeverity.MEDIUM,
    category: AuditCategory.AUTHENTICATION,
    source: 'api',
    requestId: 'req-1',
    description: 'Failed login',
    beforeState: null,
    afterState: null,
    metadata: null,
    ipAddress: '203.0.113.0',
    userAgent: 'test-agent',
    correlationId: 'corr-1',
    retentionUntil: null,
    integrityHash: null,
    archived: false,
    user: null,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityMonitoringService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            count: jest.fn(),
            find: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SecurityMonitoringService>(SecurityMonitoringService);
    repository = module.get<Repository<AuditLog>>(
      getRepositoryToken(AuditLog),
    ) as jest.Mocked<Repository<AuditLog>>;
  });

  describe('checkFailedLogins', () => {
    it('should return incident when threshold is exceeded', async () => {
      (repository.count as jest.Mock).mockResolvedValue(6);

      const incident = await service.checkFailedLogins('user-1');

      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('BRUTE_FORCE_LOGIN');
      expect(incident!.severity).toBe('HIGH');
      expect(incident!.actor).toBe('user-1');
    });

    it('should return null when threshold is not exceeded', async () => {
      (repository.count as jest.Mock).mockResolvedValue(2);

      const incident = await service.checkFailedLogins('user-1');

      expect(incident).toBeNull();
    });
  });

  describe('checkPermissionEscalation', () => {
    it('should return incident when permission changes exceed threshold', async () => {
      (repository.count as jest.Mock).mockResolvedValue(5);

      const incident = await service.checkPermissionEscalation('user-1');

      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('PERMISSION_ESCALATION');
    });

    it('should return null when permission changes are normal', async () => {
      (repository.count as jest.Mock).mockResolvedValue(1);

      const incident = await service.checkPermissionEscalation('user-1');

      expect(incident).toBeNull();
    });
  });

  describe('checkSuspiciousApiUsage', () => {
    it('should return incident when API calls exceed threshold', async () => {
      const incident = await service.checkSuspiciousApiUsage('user-1', 150);

      expect(incident).not.toBeNull();
      expect(incident!.type).toBe('SUSPICIOUS_API_USAGE');
      expect(incident!.severity).toBe('MEDIUM');
    });

    it('should return null when API calls are within limits', async () => {
      const incident = await service.checkSuspiciousApiUsage('user-1', 10);

      expect(incident).toBeNull();
    });
  });

  describe('getRecentSecurityEvents', () => {
    it('should return grouped security events', async () => {
      const logs = [
        mockAuditLog({ actionType: AuditActionType.LOGIN_FAILED, userId: 'user-1' }),
        mockAuditLog({ actionType: AuditActionType.PERMISSION_CHANGED, userId: 'user-2', severity: AuditSeverity.HIGH }),
      ];

      (repository.find as jest.Mock).mockResolvedValue(logs);

      const events = await service.getRecentSecurityEvents(60);

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('SECURITY_EVENT');
    });
  });

  describe('getFailedLoginReport', () => {
    it('should return failed login report grouped by user', async () => {
      const logs = [
        mockAuditLog({ userId: 'user-1' }),
        mockAuditLog({ userId: 'user-1' }),
        mockAuditLog({ userId: 'user-2' }),
      ];

      (repository.find as jest.Mock).mockResolvedValue(logs);

      const report = await service.getFailedLoginReport(7);

      expect(report.total).toBe(3);
      expect(report.byUser['user-1']).toBe(2);
      expect(report.byUser['user-2']).toBe(1);
    });
  });

  describe('getAdminActivityReport', () => {
    it('should return admin activity report', async () => {
      const logs = [
        mockAuditLog({
          category: AuditCategory.ADMINISTRATIVE,
          actionType: AuditActionType.ADMIN_ACTION,
          userId: 'admin-1',
        }),
        mockAuditLog({
          category: AuditCategory.ADMINISTRATIVE,
          actionType: AuditActionType.CONFIGURATION_CHANGED,
          userId: 'admin-1',
        }),
      ];

      (repository.find as jest.Mock).mockResolvedValue(logs);

      const report = await service.getAdminActivityReport(30);

      expect(report.total).toBe(2);
      expect(report.byAdmin['admin-1']).toBe(2);
    });
  });
});
