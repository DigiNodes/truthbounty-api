import { Test, TestingModule } from '@nestjs/testing';
import { AuditQueueService, AUDIT_QUEUE_NAME } from './audit-queue.service';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AuditActionType, AuditEntityType } from '../entities/audit-log.entity';

describe('AuditQueueService', () => {
  let service: AuditQueueService;
  let queue: jest.Mocked<Queue>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    queue = {
      add: jest.fn(),
      addBulk: jest.fn(),
      getWaitingCount: jest.fn(),
      getActiveCount: jest.fn(),
      getCompletedCount: jest.fn(),
      getFailedCount: jest.fn(),
      getDelayedCount: jest.fn(),
    } as unknown as jest.Mocked<Queue>;

    configService = {
      get: jest.fn().mockImplementation((key: string, defaultValue?: any) => {
        if (key === 'audit.asyncWritesEnabled') return true;
        return defaultValue;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditQueueService,
        {
          provide: getQueueToken(AUDIT_QUEUE_NAME),
          useValue: queue,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    service = module.get<AuditQueueService>(AuditQueueService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('enqueue', () => {
    it('should add a job to the queue', async () => {
      const input = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      };

      await service.enqueue(input);

      expect(queue.add).toHaveBeenCalledWith('write', input, expect.objectContaining({
        attempts: 3,
      }));
    });

    it('should handle queue errors gracefully', async () => {
      (queue.add as jest.Mock).mockRejectedValue(new Error('Queue unavailable'));

      await expect(service.enqueue({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      })).resolves.toBeUndefined();
    });
  });

  describe('enqueueBatch', () => {
    it('should add bulk jobs to the queue', async () => {
      const inputs = [
        {
          actionType: AuditActionType.CLAIM_CREATED,
          entityType: AuditEntityType.CLAIM,
          entityId: 'claim-1',
        },
        {
          actionType: AuditActionType.CLAIM_UPDATED,
          entityType: AuditEntityType.CLAIM,
          entityId: 'claim-1',
        },
      ];

      await service.enqueueBatch(inputs);

      expect(queue.addBulk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'write',
            data: inputs[0],
          }),
        ]),
      );
    });

    it('should not add bulk when inputs are empty', async () => {
      await service.enqueueBatch([]);

      expect(queue.addBulk).not.toHaveBeenCalled();
    });
  });

  describe('getQueueStats', () => {
    it('should return queue statistics', async () => {
      (queue.getWaitingCount as jest.Mock).mockResolvedValue(5);
      (queue.getActiveCount as jest.Mock).mockResolvedValue(2);
      (queue.getCompletedCount as jest.Mock).mockResolvedValue(100);
      (queue.getFailedCount as jest.Mock).mockResolvedValue(3);
      (queue.getDelayedCount as jest.Mock).mockResolvedValue(1);

      const stats = await service.getQueueStats();

      expect(stats).toEqual({
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 1,
      });
    });
  });
});
