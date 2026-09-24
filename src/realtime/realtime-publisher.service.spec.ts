import { ProjectionEvent } from './entities/projection-event.entity';
import { IndexedEvent } from '../entities';
import { RealtimePublisherService } from './realtime-publisher.service';
import { ProjectionEventType, RealtimeEnvelopeType } from './realtime.enums';

describe('RealtimePublisherService', () => {
  let service: RealtimePublisherService;
  let dataSource: any;
  let bus: { publish: jest.Mock };
  let configService: { getConfig: jest.Mock };

  const config = {
    pollIntervalMs: 1000,
    maxPublishBatch: 100,
    heartbeatIntervalMs: 15000,
    maxBacklog: 5,
    maxReplayRows: 100,
  };

  function makeRepo(overrides: Record<string, jest.Mock> = {}) {
    return {
      find: jest.fn(),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => x),
      createQueryBuilder: jest.fn(),
      ...overrides,
    };
  }

  function builder(overrides: Record<string, jest.Mock> = {}) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      ...overrides,
    };
  }

  beforeEach(() => {
    bus = { publish: jest.fn() };
    configService = { getConfig: jest.fn().mockReturnValue(config) };

    const projectionRepo = makeRepo();
    const indexedRepo = makeRepo();
    projectionRepo.createQueryBuilder.mockReturnValue(builder());

    dataSource = {
      transaction: jest.fn(async (fn: any) => {
        const mgr = {
          getRepository: jest.fn().mockReturnValue(projectionRepo),
        };
        return fn(mgr);
      }),
      getRepository: jest.fn((entity: any) => {
        if (entity === ProjectionEvent) return projectionRepo;
        if (entity === IndexedEvent) return indexedRepo;
        return makeRepo();
      }),
    };

    service = new RealtimePublisherService(
      dataSource,
      bus as any,
      configService as any,
    );
  });

  describe('publishPending / publishOnce', () => {
    it('publishes committed un-published rows and marks them published', async () => {
      const rows = [
        {
          id: 1,
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.CREATED,
          payload: { a: 1 },
          finalized: true,
          createdAt: new Date(),
        },
        {
          id: 2,
          aggregateType: 'reward',
          aggregateId: 'r1',
          eventType: ProjectionEventType.UPDATED,
          payload: { b: 2 },
          finalized: true,
          createdAt: new Date(),
        },
      ];

      const projectionRepo = dataSource.getRepository(ProjectionEvent);
      let calls = 0;
      projectionRepo.find.mockImplementation(() => {
        calls += 1;
        if (calls === 1) return rows;
        return [];
      });

      await service.publishOnce(100);

      expect(bus.publish).toHaveBeenCalledTimes(2);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: 1,
          type: RealtimeEnvelopeType.EVENT,
        }),
      );
      // rollback detect: finalized projection by default returns [] from find
    });

    it('emits rollback envelopes for rollback-type outbox rows', async () => {
      const rows = [
        {
          id: 3,
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.ROLLBACK,
          payload: { replaced: true },
          finalized: true,
          createdAt: new Date(),
        },
      ];
      const projectionRepo = dataSource.getRepository(ProjectionEvent);
      projectionRepo.find.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);

      await service.publishOnce(100);

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: 3,
          type: RealtimeEnvelopeType.ROLLBACK,
          aggregateId: 'c1',
        }),
      );
    });

    it('does not publish when there are no rows', async () => {
      const projectionRepo = dataSource.getRepository(ProjectionEvent);
      projectionRepo.find.mockResolvedValue([]);
      await service.publishOnce(100);
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('detectRollbacks (reorg of non-finalized data)', () => {
    it('records a ROLLBACK outbox row when the source indexed event is unfinalized', async () => {
      const projectionRepo = dataSource.getRepository(ProjectionEvent);
      const indexedRepo = dataSource.getRepository(IndexedEvent);

      // publishOnce() claims un-published rows: none.
      // detectRollbacks() then finds finalized, published rows with a correlationId.
      projectionRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 10,
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.CREATED,
          payload: { a: 1 },
          finalized: true,
          published: true,
          correlationId: '0xtx1',
          createdAt: new Date(),
        },
      ]);

      // The source IndexedEvent for tx1 is no longer finalized (reorg). This
      // locks in the fix from the raw-alias bug where typed entity properties
      // (transactionHash / isFinalized) were read off getRawMany() aliases.
      const indexedBuilder = builder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { transactionHash: '0xtx1', isFinalized: false, blockNumber: 42 },
          ]),
      });
      indexedRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValue(indexedBuilder);

      // No existing rollback row for this correlationId yet -> count 0.
      const rollbackCheckBuilder = builder();
      projectionRepo.createQueryBuilder.mockReturnValue(rollbackCheckBuilder);

      await service.publishPending();

      const saved = projectionRepo.save.mock.calls[0][0];
      expect(saved).toEqual(
        expect.objectContaining({
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.ROLLBACK,
          finalized: true,
          published: false,
          correlationId: '0xtx1',
        }),
      );
    });

    it('does not duplicate a ROLLBACK row when one already exists', async () => {
      const projectionRepo = dataSource.getRepository(ProjectionEvent);
      const indexedRepo = dataSource.getRepository(IndexedEvent);

      projectionRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 20,
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.CREATED,
          payload: { a: 1 },
          finalized: true,
          published: true,
          correlationId: '0xtx2',
          createdAt: new Date(),
        },
      ]);

      indexedRepo.createQueryBuilder = jest.fn().mockReturnValue(
        builder({
          getMany: jest
            .fn()
            .mockResolvedValue([
              { transactionHash: '0xtx2', isFinalized: false, blockNumber: 43 },
            ]),
        }),
      );

      // An unpublished ROLLBACK row for this correlationId already exists.
      projectionRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValue(builder({ getCount: jest.fn().mockResolvedValue(1) }));

      await service.publishPending();

      expect(projectionRepo.save).not.toHaveBeenCalled();
    });

    it('leaves existing rows alone when all correlated indexed events are finalized', async () => {
      const projectionRepo = dataSource.getRepository(ProjectionEvent);
      const indexedRepo = dataSource.getRepository(IndexedEvent);

      projectionRepo.find.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 30,
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.CREATED,
          payload: { a: 1 },
          finalized: true,
          published: true,
          correlationId: '0xtx3',
          createdAt: new Date(),
        },
      ]);

      indexedRepo.createQueryBuilder = jest.fn().mockReturnValue(
        builder({
          getMany: jest
            .fn()
            .mockResolvedValue([
              { transactionHash: '0xtx3', isFinalized: true, blockNumber: 44 },
            ]),
        }),
      );

      await service.publishPending();

      expect(projectionRepo.save).not.toHaveBeenCalled();
    });
  });
});
