import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FindOperator, Repository } from 'typeorm';
import { FinalityPolicyService } from '../../../config/finality-policy.service';
import { DataState } from '../../common/data-state.enum';
import { DisputeStatus, ProjectDispute } from '../entities/project-dispute.entity';
import { DisputeReadModelService } from './dispute-read-model.service';
import { DisputeReadModelProvenanceService } from './dispute-read-model-provenance.service';
import { DisputeReadModelFreshnessService } from './dispute-read-model-freshness.service';
import {
  ReleaseProvenance,
  ReadModelFreshness,
} from './dispute-read-model.types';

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
    if (options?.take) {
      result = result.slice(0, options.take);
    }
    return result;
  }

  async findOne(options?: { where?: Record<string, unknown> }): Promise<T | null> {
    const results = await this.find(options);
    return results[0] ?? null;
  }

  async createQueryBuilder() {
    return {
      select: () => this,
      where: () => this,
      getRawOne: async () => {
        const maxBlock = this.rows.length > 0
          ? Math.max(...this.rows.map((r) => Number(r.blockNumber)))
          : null;
        return { maxBlock: maxBlock?.toString() ?? null };
      },
    } as any;
  }
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeProvenanceService {
  resolve() {
    return PROVENANCE;
  }
}

class FakeFreshnessService {
  async snapshot() {
    return healthyFreshness();
  }
}

class FakeFinalityPolicyService {
  classifyByCheckpoint(_blockNumber: string, _checkpoint: any) {
    return DataState.FINALIZED;
  }
}

describe('DisputeReadModelService', () => {
  let service: DisputeReadModelService;
  let disputeRepo: FakeRepo<ProjectDispute>;
  let roundRepo: FakeRepo<any>;
  let provenanceService: FakeProvenanceService;
  let freshnessService: FakeFreshnessService;
  let finalityPolicy: FakeFinalityPolicyService;

  beforeEach(() => {
    disputeRepo = new FakeRepo<ProjectDispute>();
    roundRepo = new FakeRepo<any>();
    provenanceService = new FakeProvenanceService();
    freshnessService = new FakeFreshnessService();
    finalityPolicy = new FakeFinalityPolicyService();

    service = new DisputeReadModelService(
      disputeRepo as unknown as Repository<ProjectDispute>,
      roundRepo as unknown as Repository<any>,
      provenanceService as unknown as DisputeReadModelProvenanceService,
      freshnessService as unknown as DisputeReadModelFreshnessService,
      finalityPolicy as unknown as FinalityPolicyService,
    );
  });

  describe('getList', () => {
    it('returns empty register when no disputes exist', async () => {
      const result = await service.getList({});
      expect(result.data).toEqual([]);
      expect(result.readModel).toBe('dispute-register');
      expect(result.readModelVersion).toBe('dispute-read-model/v1');
      expect(result.pagination.hasMore).toBe(false);
    });

    it('returns disputes in deterministic order', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0002:round-1',
          claimId: 'claim-0002',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'b'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '2'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850005',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
      ];

      const result = await service.getList({});
      expect(result.data.length).toBe(2);
      expect(result.data[0].disputeId).toBe('claim-0001:round-1');
      expect(result.data[1].disputeId).toBe('claim-0002:round-1');
    });

    it('paginates with cursor', async () => {
      for (let i = 1; i <= 25; i++) {
        disputeRepo.rows.push({
          disputeId: `claim-${String(i).padStart(4, '0')}:round-1`,
          claimId: `claim-${String(i).padStart(4, '0')}`,
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + String(i).repeat(64),
          eventLogIndex: 0,
          blockNumber: String(24850000 + i),
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute);
      }

      const page1 = await service.getList({ limit: 20 });
      expect(page1.data.length).toBe(20);
      expect(page1.pagination.hasMore).toBe(true);
      expect(page1.pagination.nextCursor).toBeTruthy();

      const page2 = await service.getList({
        limit: 20,
        cursor: page1.pagination.nextCursor ?? undefined,
      });
      expect(page2.data.length).toBe(5);
      expect(page2.pagination.hasMore).toBe(false);
    });

    it('filters by status', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
        {
          disputeId: 'claim-0002:round-1',
          claimId: 'claim-0002',
          originalRoundId: 'round-1',
          status: DisputeStatus.RESOLVED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'b'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '2'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850020',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T01:00:00.000Z'),
          dataState: DataState.FINALIZED,
          appealRoundId: null,
          resolvedOutcome: 'overturned',
        } as ProjectDispute,
      ];

      const result = await service.getList({ status: 'raised' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].status).toBe('raised');
    });

    it('fails closed when freshness is stale', async () => {
      (freshnessService as any).snapshot = async () =>
        healthyFreshness({ stale: true, staleReasons: ['finality_unavailable'] });

      await expect(service.getList({})).rejects.toThrow(HttpException);
      const error = await service.getList({}).catch((e) => e);
      expect(error.response.code).toBe('STALE_RECONCILIATION');
      expect(error.response.failClosed).toBe(true);
    });

    it('fails closed when requested chain does not match served release', async () => {
      await expect(service.getList({ chainId: 1 })).rejects.toThrow(HttpException);
      const error = await service.getList({ chainId: 1 }).catch((e) => e);
      expect(error.response.code).toBe('UNSUPPORTED_CHAIN');
      expect(error.response.failClosed).toBe(true);
    });

    it('fails closed when requested release does not match served release', async () => {
      await expect(service.getList({ releaseId: 'wrong-release' })).rejects.toThrow(
        HttpException,
      );
      const error = await service.getList({ releaseId: 'wrong-release' }).catch((e) => e);
      expect(error.response.code).toBe('INVALID_ARTIFACT_VERSION');
      expect(error.response.failClosed).toBe(true);
    });
  });

  describe('getDetail', () => {
    it('returns dispute detail when it exists', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
      ];

      const result = await service.getDetail('claim-0001:round-1');
      expect(result.data.disputeId).toBe('claim-0001:round-1');
      expect(result.readModel).toBe('dispute-detail');
      expect(result.readModelVersion).toBe('dispute-read-model/v1');
    });

    it('fails closed when dispute does not exist', async () => {
      await expect(service.getDetail('unknown:round-1')).rejects.toThrow(HttpException);
      const error = await service.getDetail('unknown:round-1').catch((e) => e);
      expect(error.response.code).toBe('NOT_FOUND');
      expect(error.response.failClosed).toBe(true);
    });

    it('fails closed when freshness is stale', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
      ];

      (freshnessService as any).snapshot = async () =>
        healthyFreshness({ stale: true, staleReasons: ['finality_unavailable'] });

      await expect(service.getDetail('claim-0001:round-1')).rejects.toThrow(HttpException);
      const error = await service.getDetail('claim-0001:round-1').catch((e) => e);
      expect(error.response.code).toBe('STALE_RECONCILIATION');
      expect(error.response.failClosed).toBe(true);
    });
  });

  describe('phase separation', () => {
    it('provisional disputes have provisional outcome only', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-15T00:00:00.000Z'), // Past deadline
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
      ];

      const result = await service.getDetail('claim-0001:round-1');
      expect(result.data.phase).toBe('provisional');
      expect(result.data.outcome.phase).toBe('provisional');
      expect(result.data.outcome.provisional).not.toBeNull();
      expect(result.data.outcome.final).toBeNull();
    });

    it('finalized disputes have final outcome only', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RESOLVED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T01:00:00.000Z'),
          dataState: DataState.FINALIZED,
          appealRoundId: null,
          resolvedOutcome: 'overturned',
        } as ProjectDispute,
      ];

      const result = await service.getDetail('claim-0001:round-1');
      expect(result.data.phase).toBe('finalized');
      expect(result.data.outcome.phase).toBe('finalized');
      expect(result.data.outcome.provisional).toBeNull();
      expect(result.data.outcome.final).not.toBeNull();
      expect(result.data.outcome.final?.status).toBe('resolved');
    });
  });

  describe('economic values preserve exact integer units', () => {
    it('bond amount is preserved as exact integer string', async () => {
      disputeRepo.rows = [
        {
          disputeId: 'claim-0001:round-1',
          claimId: 'claim-0001',
          originalRoundId: 'round-1',
          status: DisputeStatus.RAISED,
          challengeBond: '1000000000000000000',
          challengeBondAsset: '0x' + 'a'.repeat(40),
          deadline: new Date('2026-10-20T00:00:00.000Z'),
          eventTxHash: '0x' + '1'.repeat(64),
          eventLogIndex: 0,
          blockNumber: '24850010',
          createdAt: new Date('2026-10-15T00:00:00.000Z'),
          updatedAt: new Date('2026-10-15T00:00:00.000Z'),
          dataState: DataState.OBSERVED,
          appealRoundId: null,
          resolvedOutcome: null,
        } as ProjectDispute,
      ];

      const result = await service.getDetail('claim-0001:round-1');
      expect(result.data.bond.amount).toBe('1000000000000000000');
      expect(typeof result.data.bond.amount).toBe('string');
    });
  });
});
