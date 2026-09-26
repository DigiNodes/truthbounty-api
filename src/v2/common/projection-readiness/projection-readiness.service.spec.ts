import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { ProjectionReadinessService } from './projection-readiness.service';
import {
  ProjectionReadinessCheckStatus,
  ProjectionReadinessReason,
} from './projection-readiness.types';
import { V2_PROJECTORS } from './projector-registry';
import { CanonicalEvent } from '../../events/entities/canonical-event.entity';
import { EventQuarantine } from '../../events/entities/event-quarantine.entity';
import { ProjectorCursor } from '../entities/projector-cursor.entity';

interface QueryBuilderStub {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  innerJoin: jest.Mock;
  getOne: jest.Mock;
  getCount: jest.Mock;
}

function createQueryBuilder(options: {
  one?: { blockNumber: string; logIndex: number } | null;
  count?: number;
}): QueryBuilderStub {
  const qb = {} as QueryBuilderStub;
  const chainable = (): QueryBuilderStub => qb;
  qb.select = jest.fn(chainable);
  qb.where = jest.fn(chainable);
  qb.andWhere = jest.fn(chainable);
  qb.orderBy = jest.fn(chainable);
  qb.addOrderBy = jest.fn(chainable);
  qb.limit = jest.fn(chainable);
  qb.innerJoin = jest.fn(chainable);
  qb.getOne = jest.fn().mockResolvedValue(options.one ?? null);
  qb.getCount = jest.fn().mockResolvedValue(options.count ?? 0);
  return qb;
}

interface ServiceHarness {
  service: ProjectionReadinessService;
  canonicalCreate: jest.Mock;
  quarantineCreate: jest.Mock;
  cursorFindOne: jest.Mock;
  headQb: QueryBuilderStub;
  pendingQb: QueryBuilderStub;
  quarantineQb: QueryBuilderStub;
}

function createHarness(options: {
  head?: { blockNumber: string; logIndex: number } | null;
  pending?: number;
  quarantine?: number;
  cursor?: { lastBlockNumber: string; lastLogIndex: number } | null;
  headQueryThrows?: boolean;
  quarantineConfig?: string | number | undefined;
}): ServiceHarness {
  const headQb = createQueryBuilder({ one: options.head ?? null });
  if (options.headQueryThrows) {
    headQb.getOne = jest
      .fn()
      .mockRejectedValue(new Error('canonical event table is unreadable'));
  }
  const pendingQb = createQueryBuilder({ count: options.pending ?? 0 });
  const quarantineQb = createQueryBuilder({ count: options.quarantine ?? 0 });

  // The first builder built on the canonical-event repository reads the head;
  // any later one counts the projector's backlog.
  let canonicalBuilderCount = 0;
  const canonicalCreate = jest.fn(() => {
    canonicalBuilderCount += 1;
    return canonicalBuilderCount === 1 ? headQb : pendingQb;
  });
  const quarantineCreate = jest.fn(() => quarantineQb);
  const cursorFindOne = jest.fn().mockResolvedValue(options.cursor ?? null);

  const service = new ProjectionReadinessService(
    {
      createQueryBuilder: canonicalCreate,
    } as unknown as Repository<CanonicalEvent>,
    { findOne: cursorFindOne } as unknown as Repository<ProjectorCursor>,
    {
      createQueryBuilder: quarantineCreate,
    } as unknown as Repository<EventQuarantine>,
    {
      get: jest.fn().mockReturnValue(options.quarantineConfig),
    } as unknown as ConfigService,
  );

  return {
    service,
    canonicalCreate,
    quarantineCreate,
    cursorFindOne,
    headQb,
    pendingQb,
    quarantineQb,
  };
}

describe('ProjectionReadinessService (unit)', () => {
  it('is ready when the cursor matches the canonical head and nothing is quarantined', async () => {
    const { service } = createHarness({
      head: { blockNumber: '100', logIndex: 4 },
      cursor: { lastBlockNumber: '100', lastLogIndex: 4 },
      pending: 0,
      quarantine: 0,
    });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('ready');
    expect(readiness.reasons).toEqual([]);
    expect(readiness.pendingEvents).toBe(0);
    expect(readiness.cursor).toEqual({ blockNumber: '100', logIndex: 4 });
    expect(readiness.canonicalHead).toEqual({
      blockNumber: '100',
      logIndex: 4,
    });
    expect(
      readiness.checks.every(
        (check) => check.status === ProjectionReadinessCheckStatus.PASS,
      ),
    ).toBe(true);
  });

  it('is ready when the canonical stream is empty (an empty projection is the accurate answer)', async () => {
    const { service } = createHarness({ head: null, cursor: null });

    const readiness = await service.evaluate(V2_PROJECTORS.DISPUTES);

    expect(readiness.ready).toBe(true);
    expect(readiness.canonicalHead).toBeNull();
    expect(readiness.cursor).toBeNull();
  });

  it('refuses to evaluate an unregistered projector and never queries chain state for it', async () => {
    const harness = createHarness({ head: { blockNumber: '1', logIndex: 0 } });

    const readiness = await harness.service.evaluate('v2-not-a-projector');

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.UNKNOWN_PROJECTOR,
    ]);
    expect(harness.canonicalCreate).not.toHaveBeenCalled();
    expect(harness.cursorFindOne).not.toHaveBeenCalled();
  });

  it('is not ready when canonical events exist but the projector has never recorded a cursor', async () => {
    const { service } = createHarness({
      head: { blockNumber: '500', logIndex: 2 },
      cursor: null,
      pending: 3,
    });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain(
      ProjectionReadinessReason.CURSOR_MISSING,
    );
    expect(readiness.reasons).toContain(ProjectionReadinessReason.BACKLOG);
    expect(readiness.pendingEvents).toBe(3);
  });

  it('is not ready when the projector lags the canonical stream', async () => {
    const { service } = createHarness({
      head: { blockNumber: '900', logIndex: 0 },
      cursor: { lastBlockNumber: '899', lastLogIndex: 7 },
      pending: 2,
    });

    const readiness = await service.evaluate(V2_PROJECTORS.VERIFICATION);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([ProjectionReadinessReason.BACKLOG]);
    expect(readiness.pendingEvents).toBe(2);
  });

  it('is not ready when the cursor is ahead of the canonical stream (unsubstantiated progress)', async () => {
    const { service } = createHarness({
      head: { blockNumber: '700', logIndex: 0 },
      cursor: { lastBlockNumber: '701', lastLogIndex: 0 },
    });

    const readiness = await service.evaluate(V2_PROJECTORS.VERIFICATION);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.CURSOR_AHEAD_OF_STREAM,
    ]);
  });

  it('is not ready when undecodable protocol logs exceed the allowance', async () => {
    const { service } = createHarness({
      head: { blockNumber: '100', logIndex: 0 },
      cursor: { lastBlockNumber: '100', lastLogIndex: 0 },
      quarantine: 1,
      quarantineConfig: undefined,
    });

    const readiness = await service.evaluate(V2_PROJECTORS.DISPUTES);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.QUARANTINE_BACKLOG,
    ]);
    expect(readiness.quarantinedProtocolLogs).toBe(1);
    expect(readiness.quarantineThreshold).toBe(0);
  });

  it('honours a widened quarantine allowance and still reports the counts', async () => {
    const { service } = createHarness({
      head: { blockNumber: '100', logIndex: 0 },
      cursor: { lastBlockNumber: '100', lastLogIndex: 0 },
      quarantine: 2,
      quarantineConfig: '5',
    });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(true);
    expect(readiness.quarantinedProtocolLogs).toBe(2);
    expect(readiness.quarantineThreshold).toBe(5);
  });

  it('fails closed with evaluation_error when a dependency cannot be read', async () => {
    const { service } = createHarness({ headQueryThrows: true });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.EVALUATION_ERROR,
    ]);
    expect(readiness.checks[0].detail).toMatch(/not asserted/);
  });

  it('fails closed when the quarantine allowance is not a valid configuration', async () => {
    const { service } = createHarness({
      head: { blockNumber: '100', logIndex: 0 },
      cursor: { lastBlockNumber: '100', lastLogIndex: 0 },
      quarantineConfig: 'not-a-number',
    });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.EVALUATION_ERROR,
    ]);
  });

  it('rejects a negative quarantine allowance rather than widening the gate', async () => {
    const { service } = createHarness({
      head: { blockNumber: '100', logIndex: 0 },
      cursor: { lastBlockNumber: '100', lastLogIndex: 0 },
      quarantineConfig: '-1',
    });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.EVALUATION_ERROR,
    ]);
  });

  it('treats a malformed cursor coordinate as an integrity failure, not as block zero', async () => {
    const { service } = createHarness({
      head: { blockNumber: '100', logIndex: 0 },
      cursor: { lastBlockNumber: 'not-a-block', lastLogIndex: 0 },
    });

    const readiness = await service.evaluate(V2_PROJECTORS.EVIDENCE);

    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toEqual([
      ProjectionReadinessReason.EVALUATION_ERROR,
    ]);
  });

  it('evaluates every registered projector and only reports ready when all are ready', async () => {
    const harness = createHarness({
      head: { blockNumber: '100', logIndex: 0 },
      cursor: { lastBlockNumber: '100', lastLogIndex: 0 },
    });

    const report = await harness.service.evaluateAll();

    expect(report.projectors).toHaveLength(3);
    expect(report.ready).toBe(true);
    expect(report.status).toBe('ready');
  });

  describe('assertReady', () => {
    it('resolves for a ready projection', async () => {
      const { service } = createHarness({
        head: { blockNumber: '100', logIndex: 0 },
        cursor: { lastBlockNumber: '100', lastLogIndex: 0 },
      });

      await expect(
        service.assertReady(V2_PROJECTORS.EVIDENCE),
      ).resolves.toBeUndefined();
    });

    it('throws 503 with actionable detail instead of returning unverified data', async () => {
      const { service } = createHarness({
        head: { blockNumber: '900', logIndex: 0 },
        cursor: { lastBlockNumber: '899', lastLogIndex: 0 },
        pending: 4,
      });

      await expect(
        service.assertReady(V2_PROJECTORS.EVIDENCE),
      ).rejects.toMatchObject({
        status: 503,
        response: {
          error: 'projection_not_ready',
          projector: 'v2-evidence',
          reasons: [ProjectionReadinessReason.BACKLOG],
          pendingEvents: 4,
        },
      });
    });

    it('exposes the failure through a ServiceUnavailableException', async () => {
      const { service } = createHarness({
        head: { blockNumber: '1', logIndex: 0 },
        cursor: null,
      });

      await expect(
        service.assertReady(V2_PROJECTORS.EVIDENCE),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
