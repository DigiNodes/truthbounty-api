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
    } as unknown as jest.Mocked<AuditTrailService>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;
  });

  it('should use configured retention days and purge old audit logs', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'AUDIT_LOG_RETENTION_DAYS') return '30';
      return undefined;
    });
    auditTrailService.deleteOldLogs.mockResolvedValue(8);

    service = new AuditRetentionService(auditTrailService, configService);

    await expect(service.purgeOldAuditLogs()).resolves.toBe(8);
    expect(auditTrailService.deleteOldLogs).toHaveBeenCalledWith(30);
  });

  it('should default to 365 days when configuration is missing or invalid', async () => {
    (configService.get as jest.Mock).mockReturnValue(undefined);
    auditTrailService.deleteOldLogs.mockResolvedValue(0);

    service = new AuditRetentionService(auditTrailService, configService);

    await expect(service.purgeOldAuditLogs()).resolves.toBe(0);
    expect(auditTrailService.deleteOldLogs).toHaveBeenCalledWith(365);
  });
});
