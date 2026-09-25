import { AuditRetentionService } from './audit-retention.service';
import { AuditTrailService } from './audit-trail.service';
import { ConfigService } from '@nestjs/config';

describe('AuditRetentionService', () => {
  let service: AuditRetentionService;
  let auditTrailService: jest.Mocked<AuditTrailService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    auditTrailService = {
      deleteOldLogs: jest.fn(),
      scrubAgedPii: jest.fn(),
      anonymizeUserTelemetry: jest.fn(),
    } as unknown as jest.Mocked<AuditTrailService>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;
  });

  describe('Configuration Defaults and Parsing', () => {
    it('uses configured retention and PII days', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'AUDIT_LOG_RETENTION_DAYS') return '90';
        if (key === 'AUDIT_PII_RETENTION_DAYS') return '14';
        return undefined;
      });
      auditTrailService.deleteOldLogs.mockResolvedValue(10);
      auditTrailService.scrubAgedPii.mockResolvedValue(5);

      service = new AuditRetentionService(auditTrailService, configService);

      const result = await service.enforceRetentionAndPrivacyPolicies();

      expect(result.purgedLogsCount).toBe(10);
      expect(result.scrubbedPiiCount).toBe(5);
      expect(result.retentionDays).toBe(90);
      expect(result.piiRetentionDays).toBe(14);
      expect(auditTrailService.deleteOldLogs).toHaveBeenCalledWith(90);
      expect(auditTrailService.scrubAgedPii).toHaveBeenCalledWith(14);
    });

    it('defaults to 365 days for log retention and 30 days for PII when unconfigured', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      auditTrailService.deleteOldLogs.mockResolvedValue(0);
      auditTrailService.scrubAgedPii.mockResolvedValue(0);

      service = new AuditRetentionService(auditTrailService, configService);

      const result = await service.enforceRetentionAndPrivacyPolicies();

      expect(result.retentionDays).toBe(365);
      expect(result.piiRetentionDays).toBe(30);
      expect(auditTrailService.deleteOldLogs).toHaveBeenCalledWith(365);
      expect(auditTrailService.scrubAgedPii).toHaveBeenCalledWith(30);
    });
  });

  describe('Independent Execution Tasks', () => {
    it('purges old audit logs independently', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      auditTrailService.deleteOldLogs.mockResolvedValue(12);

      service = new AuditRetentionService(auditTrailService, configService);

      await expect(service.purgeOldAuditLogs()).resolves.toBe(12);
      expect(auditTrailService.deleteOldLogs).toHaveBeenCalledWith(365);
    });

    it('scrubs old PII independently', async () => {
      (configService.get as jest.Mock).mockReturnValue(undefined);
      auditTrailService.scrubAgedPii.mockResolvedValue(25);

      service = new AuditRetentionService(auditTrailService, configService);

      await expect(service.scrubOldPii()).resolves.toBe(25);
      expect(auditTrailService.scrubAgedPii).toHaveBeenCalledWith(30);
    });
  });
});
