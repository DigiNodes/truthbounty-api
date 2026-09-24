import { ProjectionEvent } from './entities/projection-event.entity';
import { RealtimeService } from './realtime.service';
import { RealtimeBusService } from './realtime-bus.service';
import { RealtimeEnvelopeType, ProjectionEventType } from './realtime.enums';

describe('RealtimeService', () => {
  let service: RealtimeService;
  let repo: {
    createQueryBuilder: jest.Mock;
    getRepository: jest.Mock;
  };
  let bus: {
    subscribe: jest.Mock;
  };
  let configService: {
    getConfig: jest.Mock;
  };

  let manager: {
    getRepository: jest.Mock;
  };
  let managerRepo: {
    create: jest.Mock;
    save: jest.Mock;
  };

  const config = {
    pollIntervalMs: 1000,
    maxPublishBatch: 100,
    heartbeatIntervalMs: 15000,
    maxBacklog: 5,
    maxReplayRows: 100,
  };

  beforeEach(() => {
    managerRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ ...x, id: 42 })),
    };
    manager = {
      getRepository: jest.fn().mockReturnValue(managerRepo),
    };

    repo = {
      createQueryBuilder: jest.fn(),
      getRepository: jest.fn(),
    };

    const fakeBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repo.createQueryBuilder.mockReturnValue(fakeBuilder as any);

    bus = {
      subscribe: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
    };

    configService = {
      getConfig: jest.fn().mockReturnValue(config),
    };

    service = new (RealtimeService as any)(
      repo as any,
      bus as any,
      configService as any,
    );
  });

  describe('emitWithinTransaction', () => {
    it('records a validated projection change within the caller transaction manager', async () => {
      const result = await service.emitWithinTransaction(manager as any, {
        aggregateType: 'claim',
        aggregateId: 'claim_1',
        eventType: ProjectionEventType.CREATED,
        payload: { status: 'open' },
        finalized: true,
      });

      expect(manager.getRepository).toHaveBeenCalledWith(ProjectionEvent);
      expect(managerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          aggregateType: 'claim',
          aggregateId: 'claim_1',
          eventType: ProjectionEventType.CREATED,
          finalized: true,
          published: false,
        }),
      );
      expect(result.id).toBe(42);
    });

    it.each([
      [
        'empty aggregateType',
        {
          aggregateType: '',
          aggregateId: 'a',
          eventType: ProjectionEventType.CREATED,
          payload: {},
        },
      ],
      [
        'empty aggregateId',
        {
          aggregateType: 'a',
          aggregateId: '',
          eventType: ProjectionEventType.CREATED,
          payload: {},
        },
      ],
      [
        'missing payload (undefined)',
        {
          aggregateType: 'a',
          aggregateId: 'b',
          eventType: ProjectionEventType.CREATED,
          payload: undefined,
        },
      ],
      [
        'array payload',
        {
          aggregateType: 'a',
          aggregateId: 'b',
          eventType: ProjectionEventType.CREATED,
          payload: [1, 2],
        },
      ],
    ] as [string, any][])(
      'rejects %s at the boundary',
      async (_name, badChange) => {
        await expect(
          service.emitWithinTransaction(manager as any, badChange),
        ).rejects.toThrow();
        expect(manager.getRepository).not.toHaveBeenCalledWith(ProjectionEvent);
      },
    );
  });

  describe('emitRollback', () => {
    it('records a rollback/replacement envelope', async () => {
      await service.emitRollback(manager as any, {
        aggregateType: 'claim',
        aggregateId: 'claim_1',
        correlationId: '0xabc',
        payload: { replaced: true },
      });

      expect(managerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          aggregateType: 'claim',
          aggregateId: 'claim_1',
          eventType: ProjectionEventType.ROLLBACK,
          correlationId: '0xabc',
        }),
      );
    });
  });

  describe('streamFrom', () => {
    const flush = () => new Promise<void>((r) => setImmediate(r));

    it('replays committed outbox rows after the resume cursor', async () => {
      const rows = [
        {
          id: 10,
          aggregateType: 'claim',
          aggregateId: 'c1',
          eventType: ProjectionEventType.CREATED,
          payload: { a: 1 },
          finalized: true,
          createdAt: new Date(),
        },
        {
          id: 11,
          aggregateType: 'claim',
          aggregateId: 'c2',
          eventType: ProjectionEventType.UPDATED,
          payload: { a: 2 },
          finalized: true,
          createdAt: new Date(),
        },
      ] as unknown as ProjectionEvent[];

      const builder = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      repo.createQueryBuilder.mockReturnValue(builder);

      const received: any[] = [];
      const sub = service
        .streamFrom({ afterId: 5 })
        .subscribe((e) => received.push(e));
      await flush();
      await flush();
      sub.unsubscribe();

      const replayed = received.filter(
        (e) => e.type === RealtimeEnvelopeType.EVENT,
      );
      expect(replayed.map((e) => e.sourceCursor)).toEqual([10, 11]);
    });

    it('applies the last cursor to the snapshot envelope when there is no replay', async () => {
      const builder = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValue(builder);

      const received: any[] = [];
      const sub = service
        .streamFrom({ afterId: 99 })
        .subscribe((e) => received.push(e));
      await flush();
      await flush();
      sub.unsubscribe();

      const snapshot = received.find(
        (e) => e.type === RealtimeEnvelopeType.SNAPSHOT,
      );
      expect(snapshot).toBeDefined();
      expect(snapshot.cursor).toBe(99);
    });

    it('emits heartbeats on idle streams', async () => {
      jest.useFakeTimers();
      const builder = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValue(builder);
      configService.getConfig.mockReturnValue({
        ...config,
        heartbeatIntervalMs: 10,
      });

      const received: any[] = [];
      const sub = service
        .streamFrom({ afterId: 0, heartbeatIntervalMs: 10 })
        .subscribe((e) => {
          received.push(e);
        });

      jest.advanceTimersByTime(50);
      sub.unsubscribe();
      jest.useRealTimers();

      expect(
        received.some((e) => e.type === RealtimeEnvelopeType.HEARTBEAT),
      ).toBe(true);
    });

    it('delivers live envelopes published after replay', async () => {
      const builder = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValue(builder);

      const liveHandlerHolder: { fn?: (e: any) => void } = {};
      bus.subscribe.mockImplementation((fn) => {
        liveHandlerHolder.fn = fn;
        return { unsubscribe: jest.fn() };
      });

      const received: any[] = [];
      const sub = service
        .streamFrom({ afterId: 0 })
        .subscribe((e) => received.push(e));
      await flush();
      await flush();

      const envelope = {
        cursor: 7,
        type: RealtimeEnvelopeType.EVENT,
        sourceCursor: 7,
        aggregateType: 'claim',
        aggregateId: 'c1',
        timestamp: new Date().toISOString(),
      };
      liveHandlerHolder.fn?.(envelope);
      await flush();
      sub.unsubscribe();

      expect(received.some((e) => e.sourceCursor === 7)).toBe(true);
    });
  });
});
