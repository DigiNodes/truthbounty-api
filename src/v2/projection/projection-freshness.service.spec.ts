import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BlockchainStateService } from '../../blockchain/state.service';
import { DataState } from '../common/data-state.enum';
import { EventCheckpoint } from '../events/entities/event-checkpoint.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import { ProjectionFreshnessService } from './projection-freshness.service';

function healthySnapshot(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe('ProjectionFreshnessService', () => {
  let service: ProjectionFreshnessService;
  let cursorRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let checkpointRepo: { find: jest.Mock };
  let blockchainState: { getIndexerHealth: jest.Mock };

  const cursorUpdatedAt = new Date('2026-01-01T00:00:00.000Z');

  beforeEach(async () => {
    cursorRepo = { find: jest.fn(), findOne: jest.fn() };
    checkpointRepo = { find: jest.fn() };
    blockchainState = { getIndexerHealth: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectionFreshnessService,
        {
          provide: getRepositoryToken(ProjectorCursor),
          useValue: cursorRepo,
        },
        {
          provide: getRepositoryToken(EventCheckpoint),
          useValue: checkpointRepo,
        },
        {
          provide: BlockchainStateService,
          useValue: blockchainState,
        },
      ],
    }).compile();

    service = module.get(ProjectionFreshnessService);

    cursorRepo.find.mockResolvedValue([]);
    checkpointRepo.find.mockResolvedValue([
      {
        chainId: 10,
        contractAddress: '0x' + 'aa'.repeat(20),
        lastSafeBlock: '1050',
        lastFinalizedBlock: '1000',
        updatedAt: cursorUpdatedAt,
      },
    ]);
    blockchainState.getIndexerHealth.mockResolvedValue(healthySnapshot());
  });

  function mockCursor(projectorName: string, lastBlockNumber = '1040') {
    cursorRepo.findOne.mockImplementation(({ where }: any) =>
      where.projectorName === projectorName
        ? {
            projectorName,
            lastBlockNumber,
            lastLogIndex: 7,
            updatedAt: cursorUpdatedAt,
          }
        : null,
    );
  }

  describe('success paths', () => {
    it('returns healthy FINALIZED metadata with head distance and lastSuccess', async () => {
      mockCursor('v2-evidence', '990');

      const result = await service.getFreshness('v2-evidence');

      expect(result).toEqual({
        projectorName: 'v2-evidence',
        indexedBlock: '990',
        indexedLogIndex: 7,
        finalizedHeight: '1000',
        safeHeight: '1050',
        observedHead: 1100,
        headDistance: '110',
        lastSuccess: cursorUpdatedAt.toISOString(),
        status: 'healthy',
        degradedReason: null,
        dataState: DataState.FINALIZED,
      });
    });

    it('lists all known projectors with a timestamp', async () => {
      cursorRepo.findOne.mockResolvedValue(null);

      const list = await service.listFreshness();

      expect(typeof list.timestamp).toBe('string');
      expect(list.items.map((i) => i.projectorName)).toEqual([
        'v2-disputes',
        'v2-evidence',
        'v2-verification',
      ]);
    });

    it('includes extra persisted cursors beyond the known set', async () => {
      cursorRepo.find.mockResolvedValue([{ projectorName: 'v2-custom' }]);
      mockCursor('v2-custom', '1001');

      const list = await service.listFreshness();

      expect(list.items.map((i) => i.projectorName)).toContain('v2-custom');
    });
  });

  describe('boundary paths', () => {
    it('classifies indexed == finalized as FINALIZED with zero-safe distance math', async () => {
      mockCursor('v2-evidence', '1000');

      const result = await service.getFreshness('v2-evidence');

      expect(result.dataState).toBe(DataState.FINALIZED);
      expect(result.status).toBe('healthy');
    });

    it('classifies between safe and finalized as SAFE', async () => {
      mockCursor('v2-evidence', '1025');

      const result = await service.getFreshness('v2-evidence');

      expect(result.dataState).toBe(DataState.SAFE);
    });

    it('classifies above safe as OBSERVED', async () => {
      mockCursor('v2-evidence', '1075');

      const result = await service.getFreshness('v2-evidence');

      expect(result.dataState).toBe(DataState.OBSERVED);
    });

    it('reports headDistance 0 when indexed equals the observed head', async () => {
      mockCursor('v2-evidence', '1100');

      const result = await service.getFreshness('v2-evidence');

      expect(result.headDistance).toBe('0');
    });

    it('handles bigint-scale heights without precision loss', async () => {
      const huge = '9007199254740993123456789';
      cursorRepo.findOne.mockResolvedValue({
        projectorName: 'v2-evidence',
        lastBlockNumber: huge,
        lastLogIndex: 0,
        updatedAt: cursorUpdatedAt,
      });
      checkpointRepo.find.mockResolvedValue([
        {
          chainId: 10,
          contractAddress: '0x' + 'aa'.repeat(20),
          lastSafeBlock: huge,
          lastFinalizedBlock: huge,
          updatedAt: cursorUpdatedAt,
        },
      ]);
      blockchainState.getIndexerHealth.mockResolvedValue(
        healthySnapshot({ observedHeadBlock: Number.MAX_SAFE_INTEGER }),
      );

      const result = await service.getFreshness('v2-evidence');

      expect(result.indexedBlock).toBe(huge);
      expect(result.dataState).toBe(DataState.FINALIZED);
      expect(typeof result.headDistance).toBe('string');
    });
  });

  describe('authorization posture (read-only public GET surface)', () => {
    it('performs no writes: cursor and checkpoint repos are only read', async () => {
      mockCursor('v2-evidence');

      await service.getFreshness('v2-evidence');
      await service.listFreshness();

      expect(cursorRepo.findOne).toHaveBeenCalled();
      expect(checkpointRepo.find).toHaveBeenCalled();
      expect((cursorRepo as any).upsert).toBeUndefined();
      expect((cursorRepo as any).save).toBeUndefined();
    });
  });

  describe('failure paths (bounded, observable, fail closed)', () => {
    it('rejects empty projector names', async () => {
      await expect(service.getFreshness('')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects malformed projector names', async () => {
      await expect(service.getFreshness('../evil')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.getFreshness('HAS SPACES')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('returns 404 for well-formed but unknown projectors', async () => {
      await expect(
        service.getFreshness('v2-does-not-exist'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('degrades with cursor-missing when the projector never ran (restart-safe)', async () => {
      cursorRepo.findOne.mockResolvedValue(null);

      const result = await service.getFreshness('v2-evidence');

      expect(result.status).toBe('degraded');
      expect(result.indexedBlock).toBeNull();
      expect(result.lastSuccess).toBeNull();
      expect(result.degradedReason).toContain('cursor-missing');
      expect(result.dataState).toBe(DataState.OBSERVED);
    });

    it('degrades with finality-unavailable when no checkpoint or snapshot finality exists', async () => {
      mockCursor('v2-evidence');
      checkpointRepo.find.mockResolvedValue([]);
      blockchainState.getIndexerHealth.mockResolvedValue(
        healthySnapshot({ safeBlock: 0, finalizedBlock: 0 }),
      );

      const result = await service.getFreshness('v2-evidence');

      expect(result.status).toBe('degraded');
      expect(result.finalizedHeight).toBeNull();
      expect(result.degradedReason).toContain('finality-unavailable');
    });

    it('falls back to the snapshot when checkpoints are absent but snapshot finality exists', async () => {
      mockCursor('v2-evidence', '999');
      checkpointRepo.find.mockResolvedValue([]);

      const result = await service.getFreshness('v2-evidence');

      expect(result.finalizedHeight).toBe('1000');
      expect(result.safeHeight).toBe('1050');
      expect(result.dataState).toBe(DataState.FINALIZED);
    });

    it('fails closed to unhealthy when the indexer snapshot is unavailable', async () => {
      mockCursor('v2-evidence');
      blockchainState.getIndexerHealth.mockRejectedValue(new Error('rpc down'));

      const result = await service.getFreshness('v2-evidence');

      expect(result.status).toBe('unhealthy');
      expect(result.degradedReason).toContain('indexer-health-unavailable');
      expect(result.observedHead).toBeNull();
      expect(result.headDistance).toBeNull();
    });

    it('propagates indexer degraded/unhealthy status without leaking internals', async () => {
      mockCursor('v2-evidence');
      blockchainState.getIndexerHealth.mockResolvedValue(
        healthySnapshot({ status: 'degraded' }),
      );

      const degraded = await service.getFreshness('v2-evidence');

      expect(degraded.status).toBe('degraded');
      expect(degraded.degradedReason).toContain('indexer-degraded');

      blockchainState.getIndexerHealth.mockResolvedValue(
        healthySnapshot({ status: 'unhealthy' }),
      );

      const unhealthy = await service.getFreshness('v2-evidence');

      expect(unhealthy.status).toBe('unhealthy');
      expect(unhealthy.degradedReason).toContain('indexer-unhealthy');
      expect(JSON.stringify(unhealthy)).not.toContain('0x');
    });

    it('stays available when cursor enumeration fails (known projectors still served)', async () => {
      cursorRepo.find.mockRejectedValue(new Error('db blip'));
      mockCursor('v2-evidence');

      const list = await service.listFreshness();

      expect(list.items.map((i) => i.projectorName)).toEqual([
        'v2-disputes',
        'v2-evidence',
        'v2-verification',
      ]);
    });
  });

  describe('concurrency, retry, and replay semantics', () => {
    it('is idempotent: repeated reads return identical results', async () => {
      mockCursor('v2-evidence');

      const first = await service.getFreshness('v2-evidence');
      const second = await service.getFreshness('v2-evidence');

      expect(second).toEqual(first);
    });

    it('is safe under concurrent reads', async () => {
      mockCursor('v2-evidence');

      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.getFreshness('v2-evidence')),
      );

      for (const result of results) {
        expect(result).toEqual(results[0]);
      }
    });
  });
});
