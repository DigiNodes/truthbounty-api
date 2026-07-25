import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThanOrEqual } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';

/**
 * Replay / reorg rollback is now transactional: it reverses the state applied
 * by orphaned events, deletes those event records (>= startBlock), and rewinds
 * the checkpoint — all in a single transaction.
 */
describe('BlockchainIndexerService - Replay Regression Tests', () => {
  let service: BlockchainIndexerService;
  let processedEventRepo: Repository<ProcessedEvent>;
  let dataSource: DataSource;
  let manager: any;

  const buildManager = (orphaned: Partial<ProcessedEvent>[] = []) => ({
    find: jest.fn().mockResolvedValue(orphaned),
    delete: jest.fn().mockResolvedValue({ affected: orphaned.length, raw: {} }),
    save: jest.fn().mockResolvedValue(null),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
    decrement: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue(null),
  });

  const setup = async (orphaned: Partial<ProcessedEvent>[] = []) => {
    manager = buildManager(orphaned);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(null),
      startTransaction: jest.fn().mockResolvedValue(null),
      commitTransaction: jest.fn().mockResolvedValue(null),
      rollbackTransaction: jest.fn().mockResolvedValue(null),
      release: jest.fn().mockResolvedValue(null),
      manager,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainIndexerService,
        { provide: getRepositoryToken(ProcessedEvent), useClass: Repository },
        { provide: getRepositoryToken(TokenBalance), useClass: Repository },
        { provide: getRepositoryToken(IndexerCheckpoint), useClass: Repository },
        { provide: DataSource, useValue: { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } },
      ],
    }).compile();

    service = module.get(BlockchainIndexerService);
    processedEventRepo = module.get(getRepositoryToken(ProcessedEvent));
    dataSource = module.get(DataSource);
    return queryRunner;
  };

  describe('Replay State Consistency', () => {
    it('deletes all events from startBlock onward (>=) and rewinds the checkpoint', async () => {
      await setup();

      await service.replayFromBlock(100);

      // CRITICAL regression guard: deletion must cover everything >= startBlock,
      // not just the exact block (the original double-processing bug).
      expect(manager.delete).toHaveBeenCalledWith(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(100),
      });
      // Checkpoint rewound to just before the rolled-back range.
      expect(manager.save).toHaveBeenCalledWith(
        IndexerCheckpoint,
        expect.objectContaining({ id: 1, lastBlock: 99 }),
      );
    });

    it('reverses the balance effect of orphaned Transfer events', async () => {
      await setup([
        {
          blockNumber: 101,
          logIndex: 0,
          eventType: 'Transfer',
          payload: { from: '0xa', to: '0xb', amount: '100', token: '0xc' },
        },
      ]);

      await service.replayFromBlock(100);

      // Inverse of applyTransfer: sender credited back, receiver debited.
      expect(manager.increment).toHaveBeenCalledWith(
        TokenBalance,
        { address: '0xa', tokenAddress: '0xc' },
        'balance',
        '100',
      );
      expect(manager.decrement).toHaveBeenCalledWith(
        TokenBalance,
        { address: '0xb', tokenAddress: '0xc' },
        'balance',
        '100',
      );
    });

    it('rewinds the checkpoint to 0 for a full replay from block 0', async () => {
      await setup();

      await service.replayFromBlock(0);

      expect(manager.delete).toHaveBeenCalledWith(ProcessedEvent, {
        blockNumber: MoreThanOrEqual(0),
      });
      expect(manager.save).toHaveBeenCalledWith(
        IndexerCheckpoint,
        expect.objectContaining({ id: 1, lastBlock: 0 }),
      );
    });

    it('is idempotent - repeated replays from the same block behave identically', async () => {
      const queryRunner = await setup();

      await service.replayFromBlock(100);
      await service.replayFromBlock(100);
      await service.replayFromBlock(100);

      expect(manager.delete).toHaveBeenCalledTimes(3);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(3);
      manager.delete.mock.calls.forEach((call: any[]) => {
        expect(call[0]).toBe(ProcessedEvent);
        expect(call[1]).toEqual({ blockNumber: MoreThanOrEqual(100) });
      });
    });

    it('rolls back the transaction if rollback work fails', async () => {
      const queryRunner = await setup();
      manager.delete.mockRejectedValueOnce(new Error('db error'));

      await expect(service.replayFromBlock(100)).rejects.toThrow('db error');

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });
});
