import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BlockchainStateService } from '../../blockchain/state.service';
import { DataState } from '../common/data-state.enum';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { ProjectionFreshnessService } from './projection-freshness.service';

/**
 * Exercises ProjectionFreshnessService against a real (sqlite, in-memory)
 * database so cursor/checkpoint reads, restart semantics (cursor missing
 * then present), and replay idempotency are verified against actual DB
 * behavior rather than mocked repositories.
 */
describe('ProjectionFreshnessService (integration)', () => {
  let moduleRef: TestingModule;
  let service: ProjectionFreshnessService;
  let dataSource: DataSource;
  let cursorRepo: Repository<ProjectorCursor>;
  let checkpointRepo: Repository<EventCheckpoint>;
  let blockchainState: { getIndexerHealth: jest.Mock };

  const contractAddress = '0x' + 'bb'.repeat(20);

  beforeEach(async () => {
    blockchainState = {
      getIndexerHealth: jest.fn().mockResolvedValue({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        observedHeadBlock: 1100,
        safeBlock: 1050,
        finalizedBlock: 1000,
        projectionHeadBlock: 1040,
        projectionLag: 100,
        rpcFailureCount: 0,
        replayCount: 0,
        deadLetterCount: 0,
        alertThresholds: {
          projectionLagBlocks: 150,
          rpcFailureRateWindow: 300000,
          maxDeadLetters: 100,
        },
        runbookUrl: 'https://example.invalid/runbook',
      }),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          driver: require('sqlite3'),
          entities: [ProjectorCursor, EventCheckpoint],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([ProjectorCursor, EventCheckpoint]),
      ],
      providers: [
        ProjectionFreshnessService,
        { provide: BlockchainStateService, useValue: blockchainState },
      ],
    }).compile();

    service = moduleRef.get(ProjectionFreshnessService);
    dataSource = moduleRef.get(DataSource);
    cursorRepo = dataSource.getRepository(ProjectorCursor);
    checkpointRepo = dataSource.getRepository(EventCheckpoint);

    await checkpointRepo.save({
      chainId: 10,
      contractAddress,
      lastSafeBlock: '1050',
      lastFinalizedBlock: '1000',
    });
    await cursorRepo.save({
      projectorName: 'v2-evidence',
      lastBlockNumber: '990',
      lastLogIndex: 3,
    });
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('joins real cursor and checkpoint rows into a healthy report', async () => {
    const result = await service.getFreshness('v2-evidence');

    expect(result.status).toBe('healthy');
    expect(result.indexedBlock).toBe('990');
    expect(result.finalizedHeight).toBe('1000');
    expect(result.safeHeight).toBe('1050');
    expect(result.headDistance).toBe('110');
    expect(result.dataState).toBe(DataState.FINALIZED);
    expect(result.lastSuccess).not.toBeNull();
  });

  it('survives restart semantics: missing cursor degrades, re-inserted cursor recovers', async () => {
    await cursorRepo.delete({ projectorName: 'v2-evidence' });

    const degraded = await service.getFreshness('v2-evidence');
    expect(degraded.status).toBe('degraded');
    expect(degraded.degradedReason).toContain('cursor-missing');

    await cursorRepo.save({
      projectorName: 'v2-evidence',
      lastBlockNumber: '1040',
      lastLogIndex: 0,
    });

    const recovered = await service.getFreshness('v2-evidence');
    expect(recovered.status).toBe('healthy');
    expect(recovered.indexedBlock).toBe('1040');
  });

  it('is replay/idempotency safe: repeated reads over real rows are identical', async () => {
    const first = await service.getFreshness('v2-evidence');
    const second = await service.getFreshness('v2-evidence');
    expect(second).toEqual(first);
  });

  it('reflects degraded dependencies from the live snapshot', async () => {
    blockchainState.getIndexerHealth.mockResolvedValueOnce({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      observedHeadBlock: 1100,
      safeBlock: 1050,
      finalizedBlock: 1000,
      projectionHeadBlock: 1040,
      projectionLag: 200,
      rpcFailureCount: 0,
      replayCount: 1,
      deadLetterCount: 0,
      alertThresholds: {
        projectionLagBlocks: 150,
        rpcFailureRateWindow: 300000,
        maxDeadLetters: 100,
      },
      runbookUrl: 'https://example.invalid/runbook',
    });

    const result = await service.getFreshness('v2-evidence');
    expect(result.status).toBe('degraded');
    expect(result.degradedReason).toContain('indexer-degraded');
  });
});
