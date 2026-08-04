import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditMetricsService } from './audit-metrics.service';
import { AuditLog } from '../entities/audit-log.entity';
import { Repository } from 'typeorm';
import * as client from 'prom-client';

describe('AuditMetricsService', () => {
  let service: AuditMetricsService;
  let repository: jest.Mocked<Repository<AuditLog>>;

  beforeEach(async () => {
    client.register.clear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditMetricsService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuditMetricsService>(AuditMetricsService);
    repository = module.get<Repository<AuditLog>>(
      getRepositoryToken(AuditLog),
    ) as jest.Mocked<Repository<AuditLog>>;

    await service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('incrementWrite', () => {
    it('should increment counters without throwing', () => {
      expect(() => {
        service.incrementWrite('CLAIM_CREATED', 'LOW', 'OPERATIONS');
      }).not.toThrow();
    });
  });

  describe('observeWriteDuration', () => {
    it('should observe duration without throwing', () => {
      expect(() => {
        service.observeWriteDuration(0.05);
      }).not.toThrow();
    });
  });

  describe('observeSearchDuration', () => {
    it('should observe search duration without throwing', () => {
      expect(() => {
        service.observeSearchDuration(0.1);
      }).not.toThrow();
    });
  });

  describe('incrementFailedWrite', () => {
    it('should increment failed write counter', () => {
      expect(() => {
        service.incrementFailedWrite();
      }).not.toThrow();
    });
  });

  describe('incrementExport', () => {
    it('should increment export counter', () => {
      expect(() => {
        service.incrementExport();
      }).not.toThrow();
    });
  });

  describe('incrementRetention', () => {
    it('should increment retention counter', () => {
      expect(() => {
        service.incrementRetention();
      }).not.toThrow();
    });
  });

  describe('updateStorageMetrics', () => {
    it('should update storage gauges', async () => {
      (repository.count as jest.Mock).mockResolvedValue(500);

      const mockQueryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ createdAt: new Date('2024-01-01') }),
      } as any;

      (repository.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

      await expect(service.updateStorageMetrics()).resolves.toBeUndefined();
    });

    it('should handle errors gracefully', async () => {
      (repository.count as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(service.updateStorageMetrics()).resolves.toBeUndefined();
    });
  });

  describe('getMetrics', () => {
    it('should return prometheus metrics string', async () => {
      const metrics = await service.getMetrics();
      expect(typeof metrics).toBe('string');
      expect(metrics.length).toBeGreaterThan(0);
    });
  });
});
