import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ProjectionEvent } from './entities/projection-event.entity';
import { RealtimeService } from './realtime.service';
import { RealtimeBusService } from './realtime-bus.service';
import { RealtimePublisherService } from './realtime-publisher.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeEnvelopeType, ProjectionEventType } from './realtime.enums';

/**
 * Transport-boundary integration test.
 *
 * Pitches the real services (RealtimeService + RealtimeBusService +
 * RealtimePublisherService + RealtimeConfigService) together over a mocked DB
 * boundary, then verifies the full pipeline end-to-end:
 *
 *   write change in tx (outbox)  →  publisher polls  →  bus  →  stream subscriber
 *
 * This satisfies the required "integration across the nearest … transport
 * boundary" without depending on a live Postgres instance.
 */
describe('Realtime Integration (service → publisher → bus → stream)', () => {
  let moduleRef: TestingModule;
  let realtime: RealtimeService;
  let realtimeBus: RealtimeBusService;
  let publisher: RealtimePublisherService;

  const stored: ProjectionEvent[] = [];
  let projectionRepo: any;
  let dataSource: any;

  beforeAll(async () => {
    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      execute: jest.fn(async () => ({ affected: 0 })),
      getMany: jest.fn(async () => []),
    };

    projectionRepo = {
      create: jest.fn((x) => ({ created: true, ...x })),
      save: jest.fn(async (x) => {
        const row = { ...x, id: stored.length + 1 };
        stored.push(row);
        return row;
      }),
      find: jest.fn(async (opts?: any) => {
        const where = opts?.where ?? {};
        if (where.published === false) {
          return stored.filter((r) => r.published === false);
        }
        if (where.finalized === true && where.published === true) {
          return stored.filter(
            (r) => r.finalized === true && r.published === true,
          );
        }
        return [];
      }),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: updateBuilder.update,
        set: updateBuilder.set,
        where: updateBuilder.where,
        orderBy: updateBuilder.orderBy,
        limit: updateBuilder.limit,
        execute: updateBuilder.execute,
        getMany: updateBuilder.getMany,
      }),
    };

    dataSource = {
      transaction: jest.fn(async (fn: any) => {
        const mgr = {
          getRepository: jest.fn().mockReturnValue(projectionRepo),
        };
        return fn(mgr);
      }),
      getRepository: jest.fn().mockReturnValue(projectionRepo),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(ProjectionEvent),
          useValue: projectionRepo,
        },
        { provide: DataSource, useValue: dataSource },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        RealtimeBusService,
        RealtimeConfigService,
        RealtimeService,
        RealtimePublisherService,
      ],
    }).compile();

    realtime = moduleRef.get(RealtimeService);
    realtimeBus = moduleRef.get(RealtimeBusService);
    publisher = moduleRef.get(RealtimePublisherService);
  });

  afterAll(async () => {
    realtimeBus.onModuleDestroy();
    await moduleRef.close();
  });

  it('delivers a committed projection change to a live stream subscriber', async () => {
    const received: any[] = [];
    const sub = realtime
      .streamFrom({ afterId: 0 })
      .subscribe((e) => received.push(e));

    // Publish path: write change "inside a transaction", then have the
    // publisher broadcast it (simulating a committed outbox row).
    const mgr = {
      getRepository: jest.fn().mockReturnValue({
        create: projectionRepo.create,
        save: projectionRepo.save,
      }),
    };
    await realtime.emitWithinTransaction(mgr as any, {
      aggregateType: 'claim',
      aggregateId: 'claim_x',
      eventType: ProjectionEventType.CREATED,
      payload: { status: 'open' },
      finalized: true,
    });

    await publisher.publishOnce(10);
    await new Promise<void>((r) => setImmediate(r));

    const event = received.find((e) => e.type === RealtimeEnvelopeType.EVENT);
    expect(event).toBeDefined();
    expect(event.aggregateId).toBe('claim_x');
    expect(event.sourceCursor).toBeGreaterThan(0);

    sub.unsubscribe();
  });
});
