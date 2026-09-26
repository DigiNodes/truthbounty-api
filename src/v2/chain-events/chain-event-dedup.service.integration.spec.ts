import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { ChainEventDedupService } from './chain-event-dedup.service';
import { RawChainLog } from './chain-event.types';
import { setupPrismaTestDatabase } from '../../../test/utils/prisma-test-db.helper';

describe('ChainEventDedupService (integration)', () => {
  let service: ChainEventDedupService;
  let prisma: PrismaService;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ cleanup } = setupPrismaTestDatabase('chain-event-dedup'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [ChainEventDedupService, PrismaService],
    }).compile();

    service = module.get(ChainEventDedupService);
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    cleanup();
  });

  const baseLog = (overrides: Partial<RawChainLog> = {}): RawChainLog => ({
    chainId: 10,
    contractAddress: '0xAbC0000000000000000000000000000000dEf0',
    eventName: 'ClaimSubmitted',
    blockNumber: 100n,
    blockHash: '0xblockA',
    txHash: '0xtx1',
    logIndex: 0,
    blockTimestamp: new Date('2026-01-01T00:00:00Z'),
    payload: { claimId: '0xclaim1' },
    rawArgs: { raw: true },
    ...overrides,
  });

  it('ingests a new log', async () => {
    const result = await service.ingest(baseLog());
    expect(result.status).toBe('ingested');
  });

  it('rejects an exact replay of the same (chainId, blockHash, txHash, logIndex) as a duplicate', async () => {
    const log = baseLog({ txHash: '0xtx2' });
    const first = await service.ingest(log);
    const second = await service.ingest(log);

    expect(first.status).toBe('ingested');
    expect(second.status).toBe('duplicate');
  });

  it('does NOT suppress a replacement-chain log with the same tx/logIndex under a different blockHash', async () => {
    const orphaned = baseLog({ txHash: '0xtx3', blockHash: '0xblockA' });
    const replacement = baseLog({ txHash: '0xtx3', blockHash: '0xblockB' });

    const first = await service.ingest(orphaned);
    const second = await service.ingest(replacement);

    expect(first.status).toBe('ingested');
    expect(second.status).toBe('ingested');

    const rows = await service.findAcrossBlockHashes(10, '0xtx3', 0);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.blockHash).sort()).toEqual(['0xblocka', '0xblockb']);
  });

  it('treats different logIndex values within the same tx as distinct events', async () => {
    const logA = baseLog({ txHash: '0xtx4', logIndex: 0 });
    const logB = baseLog({ txHash: '0xtx4', logIndex: 1 });

    const first = await service.ingest(logA);
    const second = await service.ingest(logB);

    expect(first.status).toBe('ingested');
    expect(second.status).toBe('ingested');
  });

  it('exists() reports true only for an exact identity match', async () => {
    const log = baseLog({ txHash: '0xtx5', blockHash: '0xblockC' });
    await service.ingest(log);

    await expect(
      service.exists({
        chainId: 10,
        blockHash: '0xblockC',
        txHash: '0xtx5',
        logIndex: 0,
      }),
    ).resolves.toBe(true);

    await expect(
      service.exists({
        chainId: 10,
        blockHash: '0xblockD',
        txHash: '0xtx5',
        logIndex: 0,
      }),
    ).resolves.toBe(false);
  });
});
