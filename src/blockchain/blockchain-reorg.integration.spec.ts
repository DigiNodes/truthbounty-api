import { DataSource, Repository } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainEvent } from './interfaces/blockchain-event.interface';

/**
 * End-to-end integration test against a real in-memory SQLite database.
 * Exercises the acceptance criteria directly:
 *   - recovery of balances after a 10-block reorg
 *   - idempotent processing of duplicate events
 *   - atomic (transactional) block persistence
 */
describe('BlockchainIndexerService (integration: reorg + idempotency)', () => {
  let dataSource: DataSource;
  let service: BlockchainIndexerService;
  let processedEventRepo: Repository<ProcessedEvent>;
  let tokenBalanceRepo: Repository<TokenBalance>;
  let checkpointRepo: Repository<IndexerCheckpoint>;

  const TOKEN = '0xtoken';
  const ALICE = '0xalice';
  const BOB = '0xbob';

  const transferAt = (blockNumber: number, amount: string): BlockchainEvent => ({
    txHash: `0xtx${blockNumber}`,
    logIndex: 0,
    blockNumber,
    eventType: 'Transfer',
    data: { from: ALICE, to: BOB, amount, token: TOKEN },
  });

  const balanceOf = async (address: string): Promise<number> => {
    const row = await tokenBalanceRepo.findOne({
      where: { address, tokenAddress: TOKEN },
    });
    return Number(row?.balance ?? 0);
  };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [ProcessedEvent, TokenBalance, IndexerCheckpoint],
      synchronize: true,
    });
    await dataSource.initialize();

    processedEventRepo = dataSource.getRepository(ProcessedEvent);
    tokenBalanceRepo = dataSource.getRepository(TokenBalance);
    checkpointRepo = dataSource.getRepository(IndexerCheckpoint);

    // Seed starting balances. increment/decrement update existing rows.
    await tokenBalanceRepo.save([
      { address: ALICE, tokenAddress: TOKEN, balance: '1000' },
      { address: BOB, tokenAddress: TOKEN, balance: '0' },
    ]);

    service = new BlockchainIndexerService(
      processedEventRepo,
      tokenBalanceRepo,
      checkpointRepo,
      dataSource,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('recovers balances and checkpoint after a 10-block reorg', async () => {
    // Index blocks 1..10: each transfers 10 from Alice to Bob.
    for (let block = 1; block <= 10; block++) {
      await service.processEvent(transferAt(block, '10'));
    }

    expect(await balanceOf(ALICE)).toBe(900);
    expect(await balanceOf(BOB)).toBe(100);
    expect(await service.getLastProcessedBlock()).toBe(10);
    expect(await processedEventRepo.count()).toBe(10);

    // Reorg: blocks 6..10 are orphaned. Roll back from block 6.
    await service.replayFromBlock(6);

    // Effect of the 5 orphaned transfers (5 x 10 = 50) must be reversed.
    expect(await balanceOf(ALICE)).toBe(950);
    expect(await balanceOf(BOB)).toBe(50);
    // Orphaned event records removed; checkpoint rewound to block 5.
    expect(await processedEventRepo.count()).toBe(5);
    expect(await service.getLastProcessedBlock()).toBe(5);

    // Re-index the canonical chain for blocks 6..10.
    for (let block = 6; block <= 10; block++) {
      await service.processEvent(transferAt(block, '10'));
    }

    // State is fully restored — no double counting, no stale balances.
    expect(await balanceOf(ALICE)).toBe(900);
    expect(await balanceOf(BOB)).toBe(100);
    expect(await service.getLastProcessedBlock()).toBe(10);
    expect(await processedEventRepo.count()).toBe(10);
  });

  it('processes duplicate events exactly once (idempotency)', async () => {
    const event = transferAt(1, '10');

    await service.processEvent(event);
    await service.processEvent(event); // duplicate delivery
    await service.processEvent(event); // and again

    expect(await balanceOf(ALICE)).toBe(990);
    expect(await balanceOf(BOB)).toBe(10);
    expect(await processedEventRepo.count()).toBe(1);
  });

  it('rolls back the whole block atomically when the checkpoint write fails', async () => {
    // First, index block 1 successfully.
    await service.processEvent(transferAt(1, '10'));
    expect(await balanceOf(ALICE)).toBe(990);
    expect(await processedEventRepo.count()).toBe(1);

    // Force a genuine mid-transaction failure: remove the checkpoint table so
    // the in-transaction checkpoint write throws. The event insert and the
    // balance mutations for block 2 must all roll back as a unit.
    await dataSource.query('DROP TABLE indexer_checkpoint');

    await expect(service.processEvent(transferAt(2, '10'))).rejects.toThrow();

    // Nothing from the failed block 2 was persisted.
    expect(await balanceOf(ALICE)).toBe(990);
    expect(await balanceOf(BOB)).toBe(10);
    expect(await processedEventRepo.count()).toBe(1);
  });
});
