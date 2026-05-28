import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JobsService } from './jobs.service';
import { AuditRetentionService } from './audit-retention.service';
import { RedisService } from '../redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { Stake } from '../staking/entities/stake.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { User } from '../entities/user.entity';
import { ClaimsCache } from '../cache/claims.cache';
import { AggregationService } from '../aggregation/aggregation.service';

describe('JobsService - Audit Retention', () => {
  let service: JobsService;
  let auditRetentionService: jest.Mocked<AuditRetentionService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const mockAuditRetentionService = {
      executeRetention: jest.fn(),
      getRetentionStats: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn(),
    };

    const mockRedisService = {
      ping: jest.fn(),
    };

    const mockClaimsCache = {
      invalidateClaim: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: AuditRetentionService,
          useValue: mockAuditRetentionService,
        },
        {
          provide: getRepositoryToken(Stake),
          useValue: { find: jest.fn() },
        },
        {
          provide: getRepositoryToken(Wallet),
          useValue: { find: jest.fn() },
        },
        {
          provide: getRepositoryToken(Claim),
          useValue: { find: jest.fn(), findOneBy: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: { find: jest.fn(), findOneBy: jest.fn(), save: jest.fn() },
        },
        {
          provide: ClaimsCache,
          useValue: mockClaimsCache,
        },
        {
          provide: AggregationService,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
    auditRetentionService = module.get(AuditRetentionService) as jest.Mocked<AuditRetentionService>;
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  describe('runAuditRetentionJob', () => {
    it('should execute audit retention when enabled', async () => {
      // Setup
      configService.get.mockReturnValue(true);
      const mockResult = {
        success: true,
        totalDeleted: 500,
        batchesProcessed: 5,
        deletedBeforeDate: new Date(),
        executionTimeMs: 1000,
      };

      auditRetentionService.executeRetention.mockResolvedValue(mockResult);

      // Execute
      await service.runAuditRetentionJob();

      // Assert
      expect(configService.get).toHaveBeenCalledWith('auditRetention.enabled', true);
      expect(auditRetentionService.executeRetention).toHaveBeenCalledTimes(1);
    });

    it('should skip execution when disabled', async () => {
      // Setup
      configService.get.mockReturnValue(false);

      // Execute
      await service.runAuditRetentionJob();

      // Assert
      expect(configService.get).toHaveBeenCalledWith('auditRetention.enabled', true);
      expect(auditRetentionService.executeRetention).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      // Setup
      configService.get.mockReturnValue(true);
      const error = new Error('Retention job failed');

      auditRetentionService.executeRetention.mockRejectedValue(error);

      // Execute - should not throw
      await expect(service.runAuditRetentionJob()).resolves.not.toThrow();

      // Assert
      expect(auditRetentionService.executeRetention).toHaveBeenCalledTimes(1);
    });

    it('should log successful completion', async () => {
      // Setup
      const logSpy = jest.spyOn(service['logger'], 'log');
      configService.get.mockReturnValue(true);

      const mockResult = {
        success: true,
        totalDeleted: 100,
        batchesProcessed: 1,
        deletedBeforeDate: new Date(),
        executionTimeMs: 500,
      };

      auditRetentionService.executeRetention.mockResolvedValue(mockResult);

      // Execute
      await service.runAuditRetentionJob();

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Starting scheduled audit log retention job',
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('100 logs deleted'),
      );

      logSpy.mockRestore();
    });

    it('should log failures', async () => {
      // Setup
      const logSpy = jest.spyOn(service['logger'], 'error');
      configService.get.mockReturnValue(true);

      const mockResult = {
        success: false,
        totalDeleted: 0,
        batchesProcessed: 0,
        deletedBeforeDate: new Date(),
        executionTimeMs: 0,
        error: 'Database error',
      };

      auditRetentionService.executeRetention.mockResolvedValue(mockResult);

      // Execute
      await service.runAuditRetentionJob();

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed'),
      );

      logSpy.mockRestore();
    });
  });
});
