import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlockchainReorgAlertService, ReorgAlertLevel } from './blockchain-reorg-alert.service';
import { ReorgEventRecord } from './entities/reorg-event.entity';

describe('BlockchainReorgAlertService', () => {
  let service: BlockchainReorgAlertService;
  let reorgEventRepo: jest.Mocked<Repository<ReorgEventRecord>>;

  const createMockRepo = () => ({
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(null),
  });

  beforeEach(async () => {
    reorgEventRepo = createMockRepo() as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainReorgAlertService,
        {
          provide: getRepositoryToken(ReorgEventRecord),
          useValue: reorgEventRepo,
        },
      ],
    }).compile();

    service = module.get<BlockchainReorgAlertService>(BlockchainReorgAlertService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('recordDetection', () => {
    it('should persist a reorg event and emit a WARN alert', async () => {
      const savedRecord = {
        id: 1,
        reorgDepth: 3,
        affectedBlockStart: 100,
        affectedBlockEnd: 102,
        orphanedEventCount: 5,
        detectedAt: new Date(),
      } as ReorgEventRecord;

      reorgEventRepo.create.mockReturnValue(savedRecord as any);
      reorgEventRepo.save.mockResolvedValue(savedRecord as any);

      const result = await service.recordDetection({
        reorgDepth: 3,
        affectedBlockStart: 100,
        affectedBlockEnd: 102,
        orphanedEventCount: 5,
      });

      expect(result).toEqual(savedRecord);
      expect(reorgEventRepo.create).toHaveBeenCalledWith({
        reorgDepth: 3,
        affectedBlockStart: 100,
        affectedBlockEnd: 102,
        orphanedEventCount: 5,
        completedSuccessfully: false,
      });
      expect(reorgEventRepo.save).toHaveBeenCalled();

      // Check alert was emitted
      const alerts = service.getRecentAlerts();
      expect(alerts.length).toBe(1);
      expect(alerts[0].level).toBe(ReorgAlertLevel.WARN);
      expect(alerts[0].phase).toBe('detected');
      expect(alerts[0].reorgEventId).toBe(1);
    });
  });

  describe('recordRollbackComplete', () => {
    it('should update the record and emit an INFO alert', async () => {
      reorgEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      await service.recordRollbackComplete(42, 1500);

      expect(reorgEventRepo.update).toHaveBeenCalledWith(42, { durationMs: 1500 });

      const alerts = service.getRecentAlerts();
      expect(alerts.length).toBe(1);
      expect(alerts[0].level).toBe(ReorgAlertLevel.INFO);
      expect(alerts[0].phase).toBe('rollback');
      expect(alerts[0].durationMs).toBe(1500);
    });
  });

  describe('recordReplayComplete', () => {
    it('should mark the record as completed and emit INFO alert', async () => {
      reorgEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      await service.recordReplayComplete(42, 10, '0xabc', 2500);

      expect(reorgEventRepo.update).toHaveBeenCalledWith(42, {
        completedSuccessfully: true,
        replayedEventCount: 10,
        canonicalHashAfterReplay: '0xabc',
        durationMs: 2500,
      });

      const alerts = service.getRecentAlerts();
      expect(alerts.length).toBe(1);
      expect(alerts[0].level).toBe(ReorgAlertLevel.INFO);
      expect(alerts[0].phase).toBe('replay');
      expect(alerts[0].replayedEventCount).toBe(10);
    });
  });

  describe('recordError', () => {
    it('should record the error and emit ERROR alert', async () => {
      reorgEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      await service.recordError(42, 'database connection lost');

      expect(reorgEventRepo.update).toHaveBeenCalledWith(42, {
        completedSuccessfully: false,
        errorMessage: 'database connection lost',
      });

      const alerts = service.getRecentAlerts();
      expect(alerts.length).toBe(1);
      expect(alerts[0].level).toBe(ReorgAlertLevel.ERROR);
      expect(alerts[0].phase).toBe('error');
      expect(alerts[0].error).toBe('database connection lost');
    });
  });

  describe('subscribe', () => {
    it('should notify subscribers when alerts are emitted', async () => {
      const received: any[] = [];
      const unsubscribe = service.subscribe((alert) => received.push(alert));

      reorgEventRepo.create.mockReturnValue({ id: 99 } as any);
      reorgEventRepo.save.mockResolvedValue({ id: 99 } as any);

      await service.recordDetection({
        reorgDepth: 1,
        affectedBlockStart: 50,
        affectedBlockEnd: 50,
        orphanedEventCount: 2,
      });

      expect(received.length).toBe(1);
      expect(received[0].reorgEventId).toBe(99);

      // Unsubscribe
      unsubscribe();
      await service.recordRollbackComplete(99, 100);

      // Should not receive the second alert
      expect(received.length).toBe(1);
    });
  });

  describe('getRecentAlerts', () => {
    it('should return alerts in newest-first order', async () => {
      reorgEventRepo.create.mockReturnValue({ id: 1 } as any);
      reorgEventRepo.save.mockResolvedValue({ id: 1 } as any);
      reorgEventRepo.update.mockResolvedValue({ affected: 1 } as any);

      await service.recordDetection({
        reorgDepth: 1,
        affectedBlockStart: 10,
        affectedBlockEnd: 10,
        orphanedEventCount: 1,
      });

      reorgEventRepo.create.mockReturnValue({ id: 2 } as any);
      reorgEventRepo.save.mockResolvedValue({ id: 2 } as any);

      await service.recordDetection({
        reorgDepth: 2,
        affectedBlockStart: 20,
        affectedBlockEnd: 21,
        orphanedEventCount: 3,
      });

      const alerts = service.getRecentAlerts();
      expect(alerts.length).toBe(2);
      // Newest first
      expect(alerts[0].reorgEventId).toBe(2);
      expect(alerts[1].reorgEventId).toBe(1);
    });

    it('should respect the limit parameter', async () => {
      reorgEventRepo.create.mockReturnValue({ id: 1 } as any);
      reorgEventRepo.save.mockResolvedValue({ id: 1 } as any);

      await service.recordDetection({
        reorgDepth: 1,
        affectedBlockStart: 10,
        affectedBlockEnd: 10,
        orphanedEventCount: 1,
      });

      const alerts = service.getRecentAlerts(0);
      expect(alerts.length).toBe(0);
    });
  });

  describe('getReorgSummary', () => {
    it('should return summary statistics', async () => {
      reorgEventRepo.count
        .mockResolvedValueOnce(5) // total
        .mockResolvedValueOnce(1); // failed
      reorgEventRepo.findOne.mockResolvedValue({
        detectedAt: new Date('2024-01-15'),
      } as any);
      reorgEventRepo.find.mockResolvedValue([
        { reorgDepth: 2 },
        { reorgDepth: 4 },
        { reorgDepth: 1 },
      ] as any);

      const summary = await service.getReorgSummary();

      expect(summary.totalReorgs).toBe(5);
      expect(summary.failedReorgs).toBe(1);
      expect(summary.lastReorgAt).toEqual(new Date('2024-01-15'));
      expect(summary.averageDepth).toBe(2.33);
    });

    it('should handle empty state', async () => {
      reorgEventRepo.count.mockResolvedValue(0);
      reorgEventRepo.findOne.mockResolvedValue(null);
      reorgEventRepo.find.mockResolvedValue([]);

      const summary = await service.getReorgSummary();

      expect(summary.totalReorgs).toBe(0);
      expect(summary.failedReorgs).toBe(0);
      expect(summary.lastReorgAt).toBeNull();
      expect(summary.averageDepth).toBe(0);
    });
  });
});
