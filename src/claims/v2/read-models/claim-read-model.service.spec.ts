import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FindOperator, Repository } from 'typeorm';
import { FinalityPolicyService } from '../../../config/finality-policy.service';
import { DataState } from '../../../v2/common/data-state.enum';
import { EvidenceStatus } from '../../../v2/evidence/entities/project-evidence.entity';
import { ClaimReadModelService } from './claim-read-model.service';
import { ClaimReadModelProvenanceService } from './claim-read-model-provenance.service';
import { ClaimReadModelFreshnessService } from './claim-read-model-freshness.service';
import {
  ReleaseProvenance,
  ReadModelFreshness,
} from './claim-read-model.types';

const CHAIN_ID = 11155420;
const RELEASE_ID = 'rel-opsepolia-20261015-v2';
const SNAPSHOT_PAST = new Date('2026-01-01T00:00:00.000Z');
const CONCURRENT_FUTURE = new Date('2030-01-01T00:00:00.000Z');

const PROVENANCE: ReleaseProvenance = {
  chainId: CHAIN_ID,
  releaseId: RELEASE_ID,
  deploymentBlock: 24850000,
  artifactChecksum: 'f'.repeat(64),
};

function healthyFreshness(
  overrides: Partial<ReadModelFreshness> = {},
): ReadModelFreshness {
  return {
    indexedBlock: '24859990',
    safeBlock: '24860010',
    finalizedBlock: '24860000',
    observedHead: 24860012,
    lagBlocks: '22',
    lastSuccess: '2026-10-16T00:00:00.000Z',
    stale: false,
    staleReasons: [],
    reorgDetected: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Faithful in-memory repository fake.
//
// `ClaimReadModel` declares a `timestamp` column, which the SQLite drivers used
// by this repo's integration tests cannot host, so this suite mirrors the
// TypeORM `find({ where, order, take })` semantics for exactly the operators the
// service uses (equality, MoreThan, LessThanOrEqual, In). The pagination,
// snapshot pinning, and fail-closed logic under test all live in the service.
// ---------------------------------------------------------------------------
function matches(value: unknown, condition: unknown): boolean {
  if (condition instanceof FindOperator) {
    const target = condition.value;
    switch (condition.type) {
      case 'moreThan':
        return (value as string) > (target as string);
      case 'lessThanOrEqual': {
        const left =
          value instanceof Date ? value.getTime() : (value as number);
        const right =
          target instanceof Date ? target.getTime() : (target as number);
        return left <= right;
      }
      case 'in':
        return (target as unknown[]).includes(value);
      default:
        throw new Error(`unsupported operator: ${String(condition.type)}`);
    }
  }
  return value === condition;
}

class FakeRepo<T extends Record<string, any>> {
  rows: T[] = [];

  async save(entity: Partial<T>): Promise<T> {
    const row = { ...entity } as T;
    this.rows.push(row);
    return row;
  }

  async find(options?: {
    where?: Record<string, unknown>;
    order?: Record<string, 'ASC' | 'DESC'>;
    take?: number;
  }): Promise<T[]> {
    let result = this.rows.filter((row) =>
      Object.entries(options?.where ?? {}).every(([key, condition]) =>
        matches(row[key], condition),
      ),
    );
    for (const [key, direction] of Object.entries(options?.order ?? {})) {
      result = [...result].sort((a, b) => {
        const left = a[key];
        const right = b[key];
        if (left === right) return 0;
        const cmp = left > right ? 1 : -1;
        return direction === 'ASC' ? cmp : -cmp;
      });
    }
    if (options?.take !== undefined) result = result.slice(0, options.take);
    return result;
  }

  async findOne(options?: {
    where?: Record<string, unknown>;
  }): Promise<T | null> {
    const found = await this.find({ where: options?.where });
    return found[0] ?? null;
  }
}

async function expectStatus(
  fn: () => Promise<unknown>,
  status: number,
): Promise<HttpException> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpException);
  const exception = thrown as HttpException;
  expect(exception.getStatus()).toBe(status);
  return exception;
}

async function expectFailClosed(
  fn: () => Promise<unknown>,
  status: number,
  code: string,
  reasonSubstring?: string,
): Promise<void> {
  const exception = await expectStatus(fn, status);
  const body = exception.getResponse() as Record<string, unknown>;
  expect(body.failClosed).toBe(true);
  expect(body.code).toBe(code);
  if (reasonSubstring) {
    expect(String(body.reason)).toContain(reasonSubstring);
  }
}

describe('ClaimReadModelService', () => {
  let service: ClaimReadModelService;
  let claimRepo: FakeRepo<any>;
  let evidenceRepo: FakeRepo<any>;
  let roundRepo: FakeRepo<any>;
  let provenance: { resolve: jest.Mock };
  let freshness: { snapshot: jest.Mock };

  const configService = {
    get: (_key: string, fallback?: unknown) => fallback,
  } as unknown as ConfigService;

  beforeEach(() => {
    claimRepo = new FakeRepo();
    evidenceRepo = new FakeRepo();
    roundRepo = new FakeRepo();
    provenance = { resolve: jest.fn(() => ({ ...PROVENANCE })) };
    freshness = { snapshot: jest.fn(async () => healthyFreshness()) };

    service = new ClaimReadModelService(
      claimRepo as unknown as Repository<any>,
      evidenceRepo as unknown as Repository<any>,
      roundRepo as unknown as Repository<any>,
      provenance as unknown as ClaimReadModelProvenanceService,
      freshness as unknown as ClaimReadModelFreshnessService,
      new FinalityPolicyService(configService),
    );
  });

  async function seedClaim(options: {
    claimId: string;
    state?: string;
    blockNumber?: string;
    eventIndex?: number;
    settledAt?: Date | null;
    createdAt?: Date;
  }): Promise<void> {
    await claimRepo.save({
      claimId: options.claimId,
      chainId: String(CHAIN_ID),
      state: options.state ?? 'UNDER_VERIFICATION',
      blockNumber: options.blockNumber ?? '24859990',
      eventTxHash: '0x' + 'a'.repeat(64),
      eventIndex: options.eventIndex ?? 0,
      stateChangedAt: new Date('2026-01-01T00:00:00.000Z'),
      settledAt: options.settledAt ?? null,
      createdAt: options.createdAt ?? SNAPSHOT_PAST,
    });
  }

  describe('list — provenance, freshness, phase', () => {
    it('publishes the versioned list bound to the served release', async () => {
      await seedClaim({ claimId: 'claim-0001' });
      await seedClaim({ claimId: 'claim-0002' });

      const result = await service.getList({ limit: 20 });

      expect(result.readModel).toBe('claim-list');
      expect(result.readModelVersion).toBe('claim-read-model/v1');
      expect(result.provenance).toEqual(PROVENANCE);
      expect(result.freshness.stale).toBe(false);
      expect(result.pagination.order).toBe('claimId:asc');
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.nextCursor).toBeNull();
      expect(result.data.map((i) => i.claimId)).toEqual([
        'claim-0001',
        'claim-0002',
      ]);
      for (const item of result.data) {
        expect(item.release).toEqual(PROVENANCE);
        expect(item.chainId).toBe(CHAIN_ID);
      }
    });

    it('separates provisional from finalized outcomes', async () => {
      await seedClaim({ claimId: 'claim-0001', state: 'SUBMITTED' });
      await seedClaim({
        claimId: 'claim-0002',
        state: 'SETTLED',
        settledAt: new Date('2025-12-31T00:00:00.000Z'),
      });

      const [provisional, finalized] = (await service.getList({ limit: 20 }))
        .data;

      expect(provisional.phase).toBe('provisional');
      expect(provisional.outcome.provisional).not.toBeNull();
      expect(provisional.outcome.final).toBeNull();
      expect(finalized.phase).toBe('finalized');
      expect(finalized.outcome.provisional).toBeNull();
      expect(finalized.outcome.final?.state).toBe('SETTLED');
      expect(finalized.dataState).toBe(DataState.FINALIZED);
    });

    it('reports evidence availability and deadlines from the projections', async () => {
      await seedClaim({ claimId: 'claim-0001' });
      await evidenceRepo.save({
        evidenceId: 'ev-1',
        claimId: 'claim-0001',
        contentDigest: 'digest-1',
        status: EvidenceStatus.ACTIVE,
        lastEventBlockNumber: '24859990',
        lastEventLogIndex: 0,
      });
      await roundRepo.save({
        roundId: 'round-1',
        claimId: 'claim-0001',
        roundType: 'first',
        roundNumber: 1,
        deadline: new Date('2026-02-01T00:00:00.000Z'),
        appealDeadline: null,
        openedAtBlock: '24859990',
        eventLogIndex: 0,
      });

      const [item] = (await service.getList({ limit: 20 })).data;

      expect(item.evidence.state).toBe('available');
      expect(item.evidence.activeCount).toBe(1);
      expect(item.evidence.finalizedCount).toBe(1);
      expect(item.deadlines.verification).toBe('2026-02-01T00:00:00.000Z');
    });

    it('filters by canonical lifecycle state', async () => {
      await seedClaim({ claimId: 'claim-0001', state: 'SUBMITTED' });
      await seedClaim({ claimId: 'claim-0002', state: 'SETTLED' });

      const result = await service.getList({ limit: 20, state: 'SETTLED' });
      expect(result.data.map((i) => i.claimId)).toEqual(['claim-0002']);
    });
  });

  describe('list — pagination consistency under concurrent ingestion', () => {
    it('produces no duplicate or skipped claim under a stable snapshot', async () => {
      for (let i = 1; i <= 5; i++) {
        await seedClaim({ claimId: `claim-000${i}` });
      }

      const first = await service.getList({ limit: 2 });
      expect(first.data.map((i) => i.claimId)).toEqual([
        'claim-0001',
        'claim-0002',
      ]);
      expect(first.pagination.hasMore).toBe(true);
      expect(first.pagination.nextCursor).not.toBeNull();

      // Concurrent ingestion mid-walk: one claim sorts before the cursor and one
      // after it, both created after the pinned snapshot.
      await seedClaim({
        claimId: 'claim-0000',
        createdAt: CONCURRENT_FUTURE,
      });
      await seedClaim({
        claimId: 'claim-0006',
        createdAt: CONCURRENT_FUTURE,
      });

      const collected = first.data.map((i) => i.claimId);
      let cursor = first.pagination.nextCursor;
      while (cursor) {
        const page = await service.getList({ limit: 2, cursor });
        collected.push(...page.data.map((i) => i.claimId));
        cursor = page.pagination.nextCursor;
      }

      expect(collected).toEqual([
        'claim-0001',
        'claim-0002',
        'claim-0003',
        'claim-0004',
        'claim-0005',
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected).not.toContain('claim-0000');
      expect(collected).not.toContain('claim-0006');
    });

    it('rejects a cursor whose state filter no longer matches the query', async () => {
      await seedClaim({ claimId: 'claim-0001' });
      await seedClaim({ claimId: 'claim-0002' });

      const first = await service.getList({
        limit: 1,
        state: 'UNDER_VERIFICATION',
      });
      expect(first.pagination.nextCursor).not.toBeNull();

      const exception = await expectStatus(
        () =>
          service.getList({
            limit: 1,
            state: 'SETTLED',
            cursor: first.pagination.nextCursor as string,
          }),
        400,
      );
      expect(String(exception.message)).toContain('Cursor filter mismatch');
    });

    it('rejects a tampered cursor with a 400', async () => {
      await expectStatus(
        () => service.getList({ limit: 20, cursor: 'not-a-cursor' }),
        400,
      );
    });

    it('rejects a cursor bound to another release', async () => {
      await seedClaim({ claimId: 'claim-0001' });
      await seedClaim({ claimId: 'claim-0002' });

      const first = await service.getList({ limit: 1 });
      const tampered = Buffer.from(
        JSON.stringify({
          v: 1,
          claimId: 'claim-0001',
          snapshotAt: first.pagination.snapshotAt,
          order: 'claimId:asc',
          chainId: 10,
          state: null,
        }),
        'utf8',
      ).toString('base64url');

      await expectFailClosed(
        () => service.getList({ limit: 1, cursor: tampered }),
        400,
        'INVALID_ARTIFACT_VERSION',
        'cursor_release_mismatch',
      );
    });
  });

  describe('fail-closed gates', () => {
    it('fails closed when the freshness snapshot is stale', async () => {
      freshness.snapshot.mockResolvedValue(
        healthyFreshness({
          stale: true,
          staleReasons: ['finality_unavailable'],
          finalizedBlock: null,
        }),
      );
      await seedClaim({ claimId: 'claim-0001' });

      await expectFailClosed(
        () => service.getList({ limit: 20 }),
        503,
        'STALE_RECONCILIATION',
        'finality_unavailable',
      );
    });

    it('fails closed on a wrong requested release', async () => {
      await expectFailClosed(
        () => service.getList({ limit: 20, releaseId: 'rel-mainnet-20990101' }),
        400,
        'INVALID_ARTIFACT_VERSION',
        'wrong_release',
      );
    });

    it('fails closed on a wrong requested chain', async () => {
      await expectFailClosed(
        () => service.getList({ limit: 20, chainId: 10 }),
        400,
        'UNSUPPORTED_CHAIN',
        'chain_release_mismatch',
      );
    });

    it('returns 404 for an unknown claim', async () => {
      await expectFailClosed(
        () => service.getDetail('claim-9999'),
        404,
        'NOT_FOUND',
        'claim_not_projected',
      );
    });
  });

  describe('evidence availability fail-closed states', () => {
    it('reports missing evidence without failing the request', async () => {
      await seedClaim({ claimId: 'claim-0001' });
      const [item] = (await service.getList({ limit: 20 })).data;
      expect(item.evidence.state).toBe('missing');
      expect(item.evidence.activeCount).toBe(0);
      expect(item.evidence.latestBlockNumber).toBeNull();
    });

    it('reports evidence that has not reached finality', async () => {
      await seedClaim({ claimId: 'claim-0001' });
      await evidenceRepo.save({
        evidenceId: 'ev-1',
        claimId: 'claim-0001',
        contentDigest: 'digest-1',
        status: EvidenceStatus.ACTIVE,
        lastEventBlockNumber: '24860005',
        lastEventLogIndex: 0,
      });

      const [item] = (await service.getList({ limit: 20 })).data;
      expect(item.evidence.state).toBe('not_finalized');
      expect(item.evidence.finalizedCount).toBe(0);
      expect(item.evidence.latestBlockNumber).toBe('24860005');
    });
  });

  describe('reorg recovery', () => {
    it('fails closed while the projection is ahead of the head, then recovers', async () => {
      await seedClaim({
        claimId: 'claim-0001',
        blockNumber: '24860050',
      });
      freshness.snapshot.mockResolvedValue(
        healthyFreshness({
          stale: true,
          staleReasons: ['reorg_detected'],
          reorgDetected: true,
        }),
      );

      await expectFailClosed(
        () => service.getList({ limit: 20 }),
        503,
        'STALE_RECONCILIATION',
        'reorg_detected',
      );
      await expectFailClosed(
        () => service.getDetail('claim-0001'),
        503,
        'STALE_RECONCILIATION',
        'reorg_detected',
      );

      // Recovery: the projection is rewound to the common ancestor and the
      // freshness snapshot is healthy again.
      claimRepo.rows[0].blockNumber = '24860005';
      freshness.snapshot.mockResolvedValue(healthyFreshness());

      const recovered = await service.getList({ limit: 20 });
      expect(recovered.freshness.reorgDetected).toBe(false);
      expect(recovered.data.map((i) => i.claimId)).toEqual(['claim-0001']);
    });
  });

  describe('detail', () => {
    it('returns the canonical detail bound to the release', async () => {
      await seedClaim({
        claimId: 'claim-0002',
        state: 'SETTLED',
        settledAt: new Date('2025-12-31T00:00:00.000Z'),
      });

      const detail = await service.getDetail('claim-0002');
      expect(detail.readModel).toBe('claim-detail');
      expect(detail.readModelVersion).toBe('claim-read-model/v1');
      expect(detail.provenance.releaseId).toBe(RELEASE_ID);
      expect(detail.data.claimId).toBe('claim-0002');
      expect(detail.data.phase).toBe('finalized');
      expect(detail.data.release).toEqual(detail.provenance);
    });
  });
});
