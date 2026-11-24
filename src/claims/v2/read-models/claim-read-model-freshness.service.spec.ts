import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { BlockchainStateService } from '../../../blockchain/state.service';
import { EventCheckpoint } from '../../../v2/events/entities/event-checkpoint.entity';
import { ClaimReadModel } from '../../entities/claim-read-model.entity';
import { ClaimReadModelFreshnessService } from './claim-read-model-freshness.service';

const CHAIN_ID = 11155420;

class CheckpointRepo {
  rows: Array<Record<string, unknown>> = [];

  async find(options?: {
    where?: Record<string, unknown>;
  }): Promise<unknown[]> {
    return this.rows.filter((row) =>
      Object.entries(options?.where ?? {}).every(
        ([key, value]) => row[key] === value,
      ),
    );
  }
}

class ClaimRepo {
  rows: Array<{ chainId: string; blockNumber: string }> = [];

  createQueryBuilder() {
    const rows = this.rows;
    let chainId: string | undefined;
    const chain = {
      select: () => chain,
      where: (_sql: string, params: { chainId: string }) => {
        chainId = params.chainId;
        return chain;
      },
      getRawOne: async () => {
        let max: string | null = null;
        for (const row of rows) {
          if (chainId !== undefined && row.chainId !== chainId) continue;
          if (max === null || BigInt(row.blockNumber) > BigInt(max)) {
            max = row.blockNumber;
          }
        }
        return { maxBlock: max };
      },
    };
    return chain;
  }
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    status: 'healthy',
    observedHeadBlock: 24860012,
    ...overrides,
  };
}

describe('ClaimReadModelFreshnessService', () => {
  let checkpoints: CheckpointRepo;
  let claims: ClaimRepo;
  let configValues: Record<string, unknown>;
  let configService: ConfigService;
  let indexerHealth: ReturnType<typeof health> | null;
  let blockchainState: { getIndexerHealth: jest.Mock };

  beforeEach(() => {
    checkpoints = new CheckpointRepo();
    claims = new ClaimRepo();
    configValues = {};
    configService = {
      get: (key: string, fallback?: unknown) =>
        key in configValues ? configValues[key] : fallback,
    } as unknown as ConfigService;
    indexerHealth = health();
    blockchainState = {
      getIndexerHealth: jest.fn(async () => indexerHealth),
    };
  });

  function build(
    includeBlockchainState = true,
  ): ClaimReadModelFreshnessService {
    return new ClaimReadModelFreshnessService(
      checkpoints as unknown as Repository<EventCheckpoint>,
      claims as unknown as Repository<ClaimReadModel>,
      configService,
      includeBlockchainState
        ? (blockchainState as unknown as BlockchainStateService)
        : undefined,
    );
  }

  async function seedCheckpoint(
    safe: string,
    finalized: string,
  ): Promise<void> {
    checkpoints.rows.push({
      chainId: CHAIN_ID,
      contractAddress: '0x' + 'cc'.repeat(20),
      lastSafeBlock: safe,
      lastFinalizedBlock: finalized,
      updatedAt: new Date('2026-10-16T00:00:00.000Z'),
    });
  }

  it('reports a healthy snapshot with a computed lag', async () => {
    await seedCheckpoint('24860010', '24860000');
    claims.rows.push({ chainId: String(CHAIN_ID), blockNumber: '24859990' });

    const snapshot = await build().snapshot(CHAIN_ID);

    expect(snapshot.stale).toBe(false);
    expect(snapshot.staleReasons).toEqual([]);
    expect(snapshot.finalizedBlock).toBe('24860000');
    expect(snapshot.safeBlock).toBe('24860010');
    expect(snapshot.indexedBlock).toBe('24859990');
    expect(snapshot.lagBlocks).toBe('22');
    expect(snapshot.reorgDetected).toBe(false);
    expect(snapshot.lastSuccess).toBe('2026-10-16T00:00:00.000Z');
  });

  it('fails closed (stale) when finality is unavailable', async () => {
    claims.rows.push({ chainId: String(CHAIN_ID), blockNumber: '24859990' });

    const snapshot = await build().snapshot(CHAIN_ID);

    expect(snapshot.stale).toBe(true);
    expect(snapshot.staleReasons).toContain('finality_unavailable');
    expect(snapshot.finalizedBlock).toBeNull();
  });

  it('detects a reorg when the projection is ahead of the observed head', async () => {
    await seedCheckpoint('24860010', '24860000');
    claims.rows.push({ chainId: String(CHAIN_ID), blockNumber: '24860050' });

    const snapshot = await build().snapshot(CHAIN_ID);

    expect(snapshot.reorgDetected).toBe(true);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.staleReasons).toContain('reorg_detected');
    expect(snapshot.lagBlocks).toBe('0');
  });

  it('fails closed when the head lag exceeds the configured budget', async () => {
    await seedCheckpoint('24860010', '24860000');
    configValues.CLAIM_READ_MODEL_MAX_LAG_BLOCKS = 100;
    claims.rows.push({ chainId: String(CHAIN_ID), blockNumber: '24859990' });
    indexerHealth = health({ observedHeadBlock: 24870000 });

    const snapshot = await build().snapshot(CHAIN_ID);

    expect(snapshot.staleReasons).toContain('head_lag_exceeded');
  });

  it('fails closed when the freshness timestamp has expired', async () => {
    await seedCheckpoint('24860010', '24860000');
    configValues.CLAIM_READ_MODEL_MAX_AGE_MS = 1000;
    claims.rows.push({ chainId: String(CHAIN_ID), blockNumber: '24859990' });

    const snapshot = await build().snapshot(CHAIN_ID);

    expect(snapshot.staleReasons).toContain('freshness_expired');
  });

  it('fails closed when the indexer snapshot is unhealthy', async () => {
    await seedCheckpoint('24860010', '24860000');
    indexerHealth = health({ status: 'unhealthy' });

    const snapshot = await build().snapshot(CHAIN_ID);

    expect(snapshot.staleReasons).toContain('indexer_unhealthy');
  });

  it('stays available without a live indexer snapshot', async () => {
    await seedCheckpoint('24860010', '24860000');
    claims.rows.push({ chainId: String(CHAIN_ID), blockNumber: '24859990' });

    const snapshot = await build(false).snapshot(CHAIN_ID);

    expect(snapshot.observedHead).toBeNull();
    expect(snapshot.lagBlocks).toBeNull();
    expect(snapshot.stale).toBe(false);
  });
});
