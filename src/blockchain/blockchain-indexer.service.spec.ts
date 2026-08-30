import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThanOrEqual } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainReorgAlertService } from './blockchain-reorg-alert.service';
import { BlockchainEvent } from './interfaces/blockchain-event.interface';

describe('BlockchainIndexerService', () => {
  let service: BlockchainIndexerService;
  let processedEventRepo: Repository<ProcessedEvent>;
  let tokenBalanceRepo: Repository<TokenBalance>;
  let checkpointRepo: Repository<IndexerCheckpoint>;
  let dataSource: DataSource;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainIndexerService,
        {
          provide: getRepositoryToken(ProcessedEvent),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(TokenBalance),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(IndexerCheckpoint),
          useClass: Repository,
        },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BlockchainIndexerService>(BlockchainIndexerService);
    processedEventRepo = module.get<Repository<ProcessedEvent>>(getRepositoryToken(ProcessedEvent));
    tokenBalanceRepo = module.get<Repository<TokenBalance>>(getRepositoryToken(TokenBalance));
    checkpointRepo = module.get<Repository<IndexerCheckpoint>>(getRepositoryToken(IndexerCheckpoint));
    dataSource = module.get<DataSource>(DataSource);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processEvent', () => {
    it('should process event exactly once', async () => {
      const event: BlockchainEvent = {
        txHash: '0x123',
        logIndex: 0,
        blockNumber: 100,
        eventType: 'Transfer',
        data: { from: '0xa', to: '0xb', amount: '100', token: '0xc' },
      };

      jest.spyOn(processedEventRepo, 'findOne').mockResolvedValue(null);
      jest.spyOn(processedEventRepo, 'create').mockReturnValue(event as any);

      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          save: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
          decrement: jest.fn().mockResolvedValue({ affected: 1 }),
          increment: jest.fn().mockResolvedValue({ affected: 1 }),
          findOne: jest.fn().mockResolvedValue({ lastBlock: 99 }),
        },
      };
      jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(mockQueryRunner as any);

      await service.processEvent(event);

      expect(processedEventRepo.findOne).toHaveBeenCalledWith({
        where: { txHash: event.txHash, logIndex: event.logIndex },
      });
      expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(ProcessedEvent, expect.objectContaining({ txHash: event.txHash }));
      expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(IndexerCheckpoint, expect.objectContaining({ lastBlock: 100, id: 1 }));
    });

    it('should create checkpoint when none exists', async () => {
      const event: BlockchainEvent = {
        txHash: '0xabc',
        logIndex: 1,
        blockNumber: 101,
        eventType: 'Transfer',
        data: { from: '0xa', to: '0xb', amount: '200', token: '0xc' },
      };

      jest.spyOn(processedEventRepo, 'findOne').mockResolvedValue(null);
      jest.spyOn(processedEventRepo, 'create').mockReturnValue(event as any);

      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          save: jest.fn().mockResolvedValue({}),
          decrement: jest.fn().mockResolvedValue({ affected: 1 }),
          increment: jest.fn().mockResolvedValue({ affected: 1 }),
          findOne: jest.fn().mockResolvedValue(null),
        },
      };
      jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(mockQueryRunner as any);

      await service.processEvent(event);

      expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(IndexerCheckpoint, expect.objectContaining({ lastBlock: 101, id: 1 }));
    });

    it('should skip duplicate events across block numbers using txHash and logIndex', async () => {
      const event: BlockchainEvent = {
        txHash: '0x123',
        logIndex: 0,
        blockNumber: 101,
        eventType: 'Transfer',
        data: {},
      };

      jest.spyOn(processedEventRepo, 'findOne').mockResolvedValue({} as ProcessedEvent);
      const createQueryRunnerSpy = jest.spyOn(dataSource, 'createQueryRunner');

      await service.processEvent(event);

      expect(processedEventRepo.findOne).toHaveBeenCalledWith({
        where: { txHash: event.txHash, logIndex: event.logIndex },
      });
      expect(createQueryRunnerSpy).not.toHaveBeenCalled();
    });

    it('should skip already processed event', async () => {
      const event: BlockchainEvent = {
        txHash: '0x123',
        logIndex: 0,
        blockNumber: 100,
        eventType: 'Transfer',
        data: {},
      };

      jest.spyOn(processedEventRepo, 'findOne').mockResolvedValue({} as ProcessedEvent);

      await service.processEvent(event);

      expect(processedEventRepo.findOne).toHaveBeenCalled();
      // No further processing should occur
    });

    it('should allow strongly typed event data using generics', () => {
      const transferEvent: BlockchainEvent<{ from: string, to: string, amount: string, token: string }> = {
        txHash: '0xabc',
        logIndex: 1,
        blockNumber: 101,
        eventType: 'Transfer',
        data: {
          from: '0xsender',
          to: '0xreceiver',
          amount: '500',
          token: '0xtoken',
        },
      };
      
      expect(transferEvent.data.amount).toBe('500');
    });
  });

  describe('replayFromBlock', () => {
    // Replay is now transactional and reverses orphaned state; the detailed
    // coverage lives in blockchain-replay.spec.ts. This is a smoke check that
    // the service drives the transaction and deletes everything >= startBlock.
    it('should transactionally delete events from startBlock onward', async () => {
      const manager = {
        find: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue({ affected: 3, raw: {} }),
        save: jest.fn().mockResolvedValue(null),
        increment: jest.fn().mockResolvedValue({ affected: 1 }),
        decrement: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockResolvedValue(null),
      };
      const queryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager,
      };
      jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner as any);

      await service.replayFromBlock(100);

      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(manager.delete).toHaveBeenCalledWith(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(100),
      });
    });
  });

  describe('handleReorg', () => {
    it('should rollback from the specified block and return stats', async () => {
      const manager = {
        find: jest.fn().mockResolvedValue([
          { blockNumber: 100, eventType: 'Transfer', payload: { from: '0xa', to: '0xb', amount: '10', token: '0xt' } },
          { blockNumber: 101, eventType: 'Transfer', payload: { from: '0xa', to: '0xb', amount: '20', token: '0xt' } },
        ]),
        delete: jest.fn().mockResolvedValue({ affected: 2, raw: {} }),
        save: jest.fn().mockResolvedValue(null),
        increment: jest.fn().mockResolvedValue({ affected: 1 }),
        decrement: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn().mockResolvedValue(null),
      };
      const queryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager,
      };
      jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner as any);

      // Provide canonicalHash to skip auto-detection
      const result = await service.handleReorg(100, '0xabc');

      expect(result.rolledBack).toBe(2);
      expect(result.rewoundTo).toBe(99);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(manager.delete).toHaveBeenCalledWith(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(100),
      });
    });

    it('should handle zero orphaned events gracefully', async () => {
      const manager = {
        find: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue({ affected: 0, raw: {} }),
        save: jest.fn().mockResolvedValue(null),
        increment: jest.fn().mockResolvedValue({ affected: 0 }),
        decrement: jest.fn().mockResolvedValue({ affected: 0 }),
        findOne: jest.fn().mockResolvedValue(null),
      };
      const queryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager,
      };
      jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner as any);

      // Provide canonicalHash to skip auto-detection
      const result = await service.handleReorg(200, '0xdef');

      expect(result.rolledBack).toBe(0);
      expect(result.rewoundTo).toBe(199);
    });

    it('should emit alerts when alertService is provided', async () => {
      const mockAlertService = {
        recordDetection: jest.fn().mockResolvedValue({ id: 42 }),
        recordRollbackComplete: jest.fn().mockResolvedValue(undefined),
        recordError: jest.fn().mockResolvedValue(undefined),
      };

      // Re-create service with alertService
      const moduleWithAlerts: TestingModule = await Test.createTestingModule({
        providers: [
          BlockchainIndexerService,
          {
            provide: getRepositoryToken(ProcessedEvent),
            useValue: {
              findOne: jest.fn().mockResolvedValue(null),
            },
          },
          {
            provide: getRepositoryToken(TokenBalance),
            useValue: {},
          },
          {
            provide: getRepositoryToken(IndexerCheckpoint),
            useValue: {
              findOne: jest.fn().mockResolvedValue(null),
            },
          },
          {
            provide: DataSource,
            useValue: {
              createQueryRunner: jest.fn().mockReturnValue({
                connect: jest.fn(),
                startTransaction: jest.fn(),
                commitTransaction: jest.fn(),
                rollbackTransaction: jest.fn(),
                release: jest.fn(),
                manager: {
                  find: jest.fn().mockResolvedValue([]),
                  delete: jest.fn().mockResolvedValue({ affected: 0, raw: {} }),
                  save: jest.fn().mockResolvedValue(null),
                  increment: jest.fn(),
                  decrement: jest.fn(),
                  findOne: jest.fn().mockResolvedValue(null),
                },
              }),
            },
          },
          {
            provide: BlockchainReorgAlertService,
            useValue: mockAlertService,
          },
        ],
      }).compile();

      const svcWithAlerts = moduleWithAlerts.get(BlockchainIndexerService);
      // Provide canonicalHash to skip auto-detection
      await svcWithAlerts.handleReorg(50, '0xabc');

      expect(mockAlertService.recordDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          affectedBlockStart: 50,
          orphanedEventCount: 0,
        }),
      );
      expect(mockAlertService.recordRollbackComplete).toHaveBeenCalled();
    });
  });
});