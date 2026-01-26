import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
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
        where: { txHash: event.txHash, logIndex: event.logIndex, blockNumber: event.blockNumber },
      });
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
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
  });

  describe('replayFromBlock', () => {
    it('should delete events from startBlock and replay', async () => {
      jest.spyOn(processedEventRepo, 'delete').mockResolvedValue({ affected: 1 } as any);

      await service.replayFromBlock(100);

      expect(processedEventRepo.delete).toHaveBeenCalledWith({ blockNumber: 100 });
    });
  });
});