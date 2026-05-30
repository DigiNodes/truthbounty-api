import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';

describe('BlockchainIndexerService - Checkpoint Commit Behavior', () => {
  let service: BlockchainIndexerService;
  let processedEventRepo: any;
  let tokenBalanceRepo: any;
  let checkpointRepo: any;
  let dataSource: any;

  beforeEach(async () => {
    processedEventRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((obj) => obj),
    };

    tokenBalanceRepo = {};

    checkpointRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(null),
    };

    const mockManager = {
      save: jest.fn().mockResolvedValue(null),
      decrement: jest.fn().mockResolvedValue(null),
      increment: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const mockQueryRunner = {
      connect: jest.fn().mockResolvedValue(null),
      startTransaction: jest.fn().mockResolvedValue(null),
      manager: mockManager,
      commitTransaction: jest.fn().mockResolvedValue(null),
      rollbackTransaction: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    } as unknown as DataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainIndexerService,
        { provide: getRepositoryToken(ProcessedEvent), useValue: processedEventRepo },
        { provide: getRepositoryToken(TokenBalance), useValue: tokenBalanceRepo },
        { provide: getRepositoryToken(IndexerCheckpoint), useValue: checkpointRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<BlockchainIndexerService>(BlockchainIndexerService);
  });

  it('saves checkpoint after commit when processing succeeds', async () => {
    const event = { txHash: '0x1', logIndex: 0, blockNumber: 123, eventType: 'Transfer', data: { from: 'a', to: 'b', amount: 1, token: 'T' } } as any;

    await service.processEvent(event);

    expect(dataSource.createQueryRunner).toHaveBeenCalled();
    // Repository.save should be called after commit
    expect(checkpointRepo.save).toHaveBeenCalledTimes(1);
    const saved = checkpointRepo.save.mock.calls[0][0];
    expect(saved.id).toBe(1);
    expect(saved.lastBlock).toBe(123);
  });

  it('does not save checkpoint when processing fails and rolls back', async () => {
    // Make manager.save throw to trigger rollback
    const failingManager = {
      save: jest.fn().mockRejectedValue(new Error('db error')),
      decrement: jest.fn(),
      increment: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const failingQueryRunner = {
      connect: jest.fn().mockResolvedValue(null),
      startTransaction: jest.fn().mockResolvedValue(null),
      manager: failingManager,
      commitTransaction: jest.fn().mockResolvedValue(null),
      rollbackTransaction: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
    };

    (dataSource.createQueryRunner as jest.Mock).mockReturnValueOnce(failingQueryRunner as any);

    const event = { txHash: '0x2', logIndex: 0, blockNumber: 200, eventType: 'Transfer', data: { from: 'x', to: 'y', amount: 5, token: 'T' } } as any;

    await expect(service.processEvent(event)).rejects.toThrow('db error');

    // checkpointRepo.save should not be called because transaction rolled back
    expect(checkpointRepo.save).not.toHaveBeenCalled();
  });
});
