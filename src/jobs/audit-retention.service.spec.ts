import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditRetentionService, AuditRetentionResult } from './audit-retention.service';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

describe('AuditRetentionService', () => {
  let service: AuditRetentionService;
  let repository: jest.Mocked<Repository<AuditLog>>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const mockRepository = {
      find: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditRetentionService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockRepository,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<AuditRetentionService>(AuditRetentionService);
    repository = module.get(getRepositoryToken(AuditLog));
    configService = module.get(ConfigService);
  });

  describe('executeRetention', () => {
    it('should successfully delete old audit logs', async () => {
      // Setup
      const retentionDays = 90;
      const batchSize = 1000;
      const maxBatches = 100;

      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return retentionDays;
        if (key === 'auditRetention.batchSize') return batchSize;
        if (key === 'auditRetention.maxBatches') return maxBatches;
        return defaultValue;
      });

      // First batch: 100 logs
      const firstBatch = Array.from({ length: 100 }, (_, i) => ({
        id: `log-${i}`,
      }));

      // Second batch: 50 logs (less than batchSize, so we stop)
      const secondBatch = Array.from({ length: 50 }, (_, i) => ({
        id: `log-100-${i}`,
      }));

      repository.find
        .mockResolvedValueOnce(firstBatch as any)
        .mockResolvedValueOnce(secondBatch as any);

      repository.delete.mockResolvedValue({ affected: 100 }).mockResolvedValueOnce({ affected: 50 });

      // Execute
      const result = await service.executeRetention();

      // Assert
      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(150);
      expect(result.batchesProcessed).toBe(2);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(repository.find).toHaveBeenCalledTimes(2);
      expect(repository.delete).toHaveBeenCalledTimes(2);
    });

    it('should handle deletion with no logs to delete', async () => {
      // Setup
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return 90;
        if (key === 'auditRetention.batchSize') return 1000;
        if (key === 'auditRetention.maxBatches') return 100;
        return defaultValue;
      });

      repository.find.mockResolvedValue([]);

      // Execute
      const result = await service.executeRetention();

      // Assert
      expect(result.success).toBe(true);
      expect(result.totalDeleted).toBe(0);
      expect(result.batchesProcessed).toBe(0);
      expect(repository.find).toHaveBeenCalledTimes(1);
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      // Setup
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return 90;
        if (key === 'auditRetention.batchSize') return 1000;
        if (key === 'auditRetention.maxBatches') return 100;
        return defaultValue;
      });

      const error = new Error('Database connection failed');
      repository.find.mockRejectedValue(error);

      // Execute
      const result = await service.executeRetention();

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database connection failed');
      expect(result.totalDeleted).toBe(0);
    });

    it('should respect maxBatches limit', async () => {
      // Setup
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return 90;
        if (key === 'auditRetention.batchSize') return 1000;
        if (key === 'auditRetention.maxBatches') return 3;
        return defaultValue;
      });

      // Create full batches (to avoid stopping on incomplete batch)
      const fullBatch = Array.from({ length: 1000 }, (_, i) => ({
        id: `log-${i}`,
      }));

      repository.find.mockResolvedValue(fullBatch as any);
      repository.delete.mockResolvedValue({ affected: 1000 });

      // Execute
      const result = await service.executeRetention();

      // Assert - should process exactly 3 batches
      expect(result.batchesProcessed).toBe(3);
      expect(result.totalDeleted).toBe(3000);
      expect(repository.find).toHaveBeenCalledTimes(3);
      expect(repository.delete).toHaveBeenCalledTimes(3);
    });

    it('should calculate cutoff date correctly', async () => {
      // Setup
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return 30;
        if (key === 'auditRetention.batchSize') return 1000;
        if (key === 'auditRetention.maxBatches') return 100;
        return defaultValue;
      });

      repository.find.mockResolvedValue([]);

      // Execute
      const result = await service.executeRetention();

      // Assert - cutoff date should be approximately 30 days ago
      const now = new Date();
      const expectedCutoff = new Date(now);
      expectedCutoff.setDate(expectedCutoff.getDate() - 30);

      const diffMs = Math.abs(
        result.deletedBeforeDate.getTime() - expectedCutoff.getTime(),
      );
      // Allow 1 second of difference due to test execution time
      expect(diffMs).toBeLessThan(1000);
    });
  });

  describe('getRetentionStats', () => {
    it('should return correct retention statistics', async () => {
      // Setup
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return 90;
        return defaultValue;
      });

      repository.count
        .mockResolvedValueOnce(10000) // Total logs
        .mockResolvedValueOnce(1500); // Logs older than retention

      // Execute
      const stats = await service.getRetentionStats();

      // Assert
      expect(stats.totalLogs).toBe(10000);
      expect(stats.logsOlderThanRetention).toBe(1500);
      expect(stats.retentionDays).toBe(90);
      expect(stats.cutoffDate).toBeDefined();
    });

    it('should handle count errors', async () => {
      // Setup
      configService.get.mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'auditRetention.retentionDays') return 90;
        return defaultValue;
      });

      const error = new Error('Count query failed');
      repository.count.mockRejectedValue(error);

      // Assert that the error is thrown (not caught)
      await expect(service.getRetentionStats()).rejects.toThrow('Count query failed');
    });
  });
});
