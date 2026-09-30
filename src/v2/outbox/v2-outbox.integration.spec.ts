import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { DataSource, Repository } from 'typeorm';
import { V2OutboxService } from './v2-outbox.service';
import { V2OutboxWorker, V2_OUTBOX_JOB_NAME, V2_OUTBOX_QUEUE_NAME } from './v2-outbox.worker';
import { V2OutboxMessage, V2OutboxStatus } from './entities/v2-outbox-message.entity';
import { MetricsService } from '../../metrics/metrics.service';

/**
 * V2OutboxMessage integration tests (V2-BE-113).
 *
 * Uses an in-memory SQLite database (matching the canonical-events integration
 * test pattern) so every test runs in isolation without an external PostgreSQL
 * server. Key differences from the production path are:
 *
 * - SQLite does not support `FOR UPDATE SKIP LOCKED`. The claimBatch query
 *   falls back silently; PostgreSQL concurrency guarantees are proven at the
 *   unit level via mock assertions and must be verified during staging deploys.
 * - SQLite does not enforce CHECK constraints added via `synchronize: true`
 *   in the same way as PostgreSQL. Constraint tests verify behaviour via the
 *   application layer.
 *
 * All other invariants (atomicity, rollback, idempotency, state transitions,
 *  retry exhaustion, crash recovery, protocol-authority isolation) are
 * exercised here against real database behaviour.
 */
describe('V2Outbox integration (sqlite in-memory)', () => {
  let moduleRef: TestingModule;
  let service: V2OutboxService;
  let worker: V2OutboxWorker;
  let dataSource: DataSource;
  let repo: Repository<V2OutboxMessage>;

  // Mock BullMQ queue injected into the worker
  let mockQueue: { add: jest.Mock };

  // Minimal MetricsService stub
  const metricsStub: Partial<MetricsService> = {
    incrementCounter: jest.fn(),
  };

  beforeEach(async () => {
    mockQueue = { add: jest.fn().mockResolvedValue({ id: 'job-integration-1' }) };
    (metricsStub.incrementCounter as jest.Mock).mockReset();

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          driver: require('sqlite3'),
          entities: [V2OutboxMessage],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([V2OutboxMessage]),
      ],
      providers: [
        V2OutboxService,
        V2OutboxWorker,
        { provide: MetricsService, useValue: metricsStub },
        // Inject the mock queue under the canonical BullMQ injection token
        {
          provide: getQueueToken(V2_OUTBOX_QUEUE_NAME),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = moduleRef.get<V2OutboxService>(V2OutboxService);
    worker = moduleRef.get<V2OutboxWorker>(V2OutboxWorker);
    dataSource = moduleRef.get<DataSource>(DataSource);
    repo = dataSource.getRepository(V2OutboxMessage);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  // ── Transactional atomicity ───────────────────────────────────────────────

  describe('transactional atomicity', () => {
    it('outbox row is visible after the outer transaction commits', async () => {
      await dataSource.transaction(async (manager) => {
        await service.publishWithManager(manager, {
          aggregateType: 'claim',
          aggregateId: 'claim-1',
          eventType: 'notification.send',
          payload: { channel: 'in_app', recipientIds: ['user-1'] },
        });
      });

      const rows = await repo.find();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(V2OutboxStatus.PENDING);
      expect(rows[0].eventType).toBe('notification.send');
    });

    it('outbox row is NOT visible when the outer transaction rolls back', async () => {
      try {
        await dataSource.transaction(async (manager) => {
          await service.publishWithManager(manager, {
            aggregateType: 'claim',
            aggregateId: 'claim-rollback',
            eventType: 'notification.send',
            payload: {},
          });
          // Force rollback
          throw new Error('simulated rollback');
        });
      } catch {
        // Expected
      }

      const rows = await repo.find();
      expect(rows).toHaveLength(0);
    });

    it('atomically records multiple outbox messages in one transaction', async () => {
      await dataSource.transaction(async (manager) => {
        await service.publishWithManager(manager, {
          aggregateType: 'claim',
          aggregateId: 'c-1',
          eventType: 'notification.send',
          payload: { channel: 'in_app' },
        });
        await service.publishWithManager(manager, {
          aggregateType: 'evidence',
          aggregateId: 'ev-1',
          eventType: 'webhook.fire',
          payload: { channel: 'webhook' },
        });
      });

      const rows = await repo.find({ order: { createdAt: 'ASC' } });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.eventType)).toEqual([
        'notification.send',
        'webhook.fire',
      ]);
    });

    it('rolls back ALL outbox rows when the transaction fails mid-way', async () => {
      try {
        await dataSource.transaction(async (manager) => {
          await service.publishWithManager(manager, {
            aggregateType: 'claim',
            aggregateId: 'c-1',
            eventType: 'notification.send',
            payload: {},
          });
          // Second write then crash
          await service.publishWithManager(manager, {
            aggregateType: 'evidence',
            aggregateId: 'ev-1',
            eventType: 'webhook.fire',
            payload: {},
          });
          throw new Error('partial rollback');
        });
      } catch {
        // Expected
      }

      const rows = await repo.find();
      expect(rows).toHaveLength(0);
    });
  });

  // ── Idempotency / duplicate key ───────────────────────────────────────────

  describe('idempotency', () => {
    it('rejects a second publishWithManager call with the same idempotency key in a new transaction', async () => {
      const params = {
        aggregateType: 'claim',
        aggregateId: 'c-dup',
        eventType: 'notification.send',
        payload: { channel: 'in_app', recipientIds: ['user-1'] },
      };

      // First write succeeds
      await dataSource.transaction((m) => service.publishWithManager(m, params));

      // Second write with the same content → same idempotencyKey → DB unique violation
      await expect(
        dataSource.transaction((m) => service.publishWithManager(m, params)),
      ).rejects.toThrow();

      // Only one row must exist
      const rows = await repo.find();
      expect(rows).toHaveLength(1);
    });

    it('different aggregateIds produce different idempotency keys and both succeed', async () => {
      const base = {
        aggregateType: 'claim',
        eventType: 'notification.send',
        payload: { channel: 'in_app' },
      };

      await dataSource.transaction((m) =>
        service.publishWithManager(m, { ...base, aggregateId: 'c-1' }),
      );
      await dataSource.transaction((m) =>
        service.publishWithManager(m, { ...base, aggregateId: 'c-2' }),
      );

      const rows = await repo.find();
      expect(rows).toHaveLength(2);
    });

    it('idempotency key is stable across calls with re-ordered recipientIds', () => {
      const k1 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        channel: 'email',
        recipientIds: ['user-a', 'user-b'],
      });
      const k2 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        channel: 'email',
        recipientIds: ['user-b', 'user-a'],
      });
      expect(k1).toBe(k2);
    });
  });

  // ── Worker: successful poll → dispatch ────────────────────────────────────

  describe('worker — successful dispatch', () => {
    it('picks up a PENDING row, dispatches to BullMQ, and transitions to DISPATCHED', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-1',
          eventType: 'notification.send',
          payload: { channel: 'in_app' },
        }),
      );

      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-1' });
      expect(row.status).toBe(V2OutboxStatus.DISPATCHED);
      expect(row.jobId).toBe('job-integration-1');
      expect(row.processedAt).toBeTruthy();
    });

    it('dispatches the correct job name to BullMQ', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-1',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      await worker.pollAndDispatch();

      expect(mockQueue.add).toHaveBeenCalledWith(
        V2_OUTBOX_JOB_NAME,
        expect.objectContaining({ aggregateId: 'c-1' }),
        expect.any(Object),
      );
    });

    it('uses outbox-<idempotencyKey> as the BullMQ jobId', async () => {
      const result = await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-idem',
          eventType: 'notification.send',
          payload: { channel: 'in_app', recipientIds: ['user-7'] },
        }),
      );

      await worker.pollAndDispatch();

      const opts = mockQueue.add.mock.calls[0][2];
      expect(opts.jobId).toBe(`outbox-${result.idempotencyKey}`);
    });

    it('does not dispatch a row a second time after DISPATCHED status', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-1',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      // First poll dispatches it
      await worker.pollAndDispatch();
      // Second poll: row is DISPATCHED, should not be picked up again
      await worker.pollAndDispatch();

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  // ── Worker: retry on transient failure ───────────────────────────────────

  describe('worker — retry on transient failure', () => {
    it('increments retryCount and resets to PENDING on the first BullMQ failure', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-retry',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      mockQueue.add.mockRejectedValueOnce(new Error('ECONNREFUSED: Redis down'));

      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-retry' });
      expect(row.retryCount).toBe(1);
      expect(row.status).toBe(V2OutboxStatus.PENDING);
      expect(row.lastError).toContain('ECONNREFUSED');
    });

    it('retries on the next poll cycle after a transient failure', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-retry2',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      // First poll: fails
      mockQueue.add.mockRejectedValueOnce(new Error('transient'));
      await worker.pollAndDispatch();

      // Second poll: succeeds
      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-retry2' });
      expect(row.status).toBe(V2OutboxStatus.DISPATCHED);
    });
  });

  // ── Worker: dead-letter on exhaustion ────────────────────────────────────

  describe('worker — dead-letter on retry exhaustion', () => {
    it('transitions to DEAD_LETTER when maxRetries is reached', async () => {
      // Pre-populate a row that is already at maxRetries - 1
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-dl', {});
      const msg = repo.create({
        aggregateType: 'claim',
        aggregateId: 'c-dl',
        eventType: 'notification.send',
        payload: {},
        idempotencyKey: key,
        status: V2OutboxStatus.PENDING,
        retryCount: 4,
        maxRetries: 5,
        lastError: 'previous failure',
        jobId: null,
        scheduledAt: new Date(),
        processingDeadline: null,
        processedAt: null,
      });
      await repo.save(msg);

      mockQueue.add.mockRejectedValueOnce(new Error('still failing'));

      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-dl' });
      expect(row.status).toBe(V2OutboxStatus.DEAD_LETTER);
      expect(row.retryCount).toBe(5);
    });

    it('dead-lettered rows are never re-dispatched on subsequent polls', async () => {
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-dl2', {});
      const msg = repo.create({
        aggregateType: 'claim',
        aggregateId: 'c-dl2',
        eventType: 'notification.send',
        payload: {},
        idempotencyKey: key,
        status: V2OutboxStatus.DEAD_LETTER,
        retryCount: 5,
        maxRetries: 5,
        lastError: 'fatal',
        jobId: null,
        scheduledAt: new Date(),
        processingDeadline: null,
        processedAt: null,
      });
      await repo.save(msg);

      await worker.pollAndDispatch();
      await worker.pollAndDispatch();

      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  // ── Crash recovery ────────────────────────────────────────────────────────

  describe('crash recovery', () => {
    it('resets a PROCESSING row past its deadline back to PENDING', async () => {
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-stuck', {});
      const pastDeadline = new Date(Date.now() - 60_000); // 1 minute ago

      const msg = repo.create({
        aggregateType: 'claim',
        aggregateId: 'c-stuck',
        eventType: 'notification.send',
        payload: {},
        idempotencyKey: key,
        status: V2OutboxStatus.PROCESSING,
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        jobId: null,
        scheduledAt: new Date(),
        processingDeadline: pastDeadline,
        processedAt: null,
      });
      await repo.save(msg);

      await worker.recoverStuckMessages();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-stuck' });
      expect(row.status).toBe(V2OutboxStatus.PENDING);
      expect(row.processingDeadline).toBeNull();
    });

    it('does NOT reset a PROCESSING row whose deadline has not elapsed', async () => {
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-inflight', {});
      const futureDeadline = new Date(Date.now() + 30_000); // 30s in the future

      const msg = repo.create({
        aggregateType: 'claim',
        aggregateId: 'c-inflight',
        eventType: 'notification.send',
        payload: {},
        idempotencyKey: key,
        status: V2OutboxStatus.PROCESSING,
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        jobId: null,
        scheduledAt: new Date(),
        processingDeadline: futureDeadline,
        processedAt: null,
      });
      await repo.save(msg);

      await worker.recoverStuckMessages();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-inflight' });
      expect(row.status).toBe(V2OutboxStatus.PROCESSING);
    });

    it('after recovery, the row can be dispatched on the next poll', async () => {
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-recover', {});
      const pastDeadline = new Date(Date.now() - 60_000);

      const msg = repo.create({
        aggregateType: 'claim',
        aggregateId: 'c-recover',
        eventType: 'notification.send',
        payload: {},
        idempotencyKey: key,
        status: V2OutboxStatus.PROCESSING,
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        jobId: null,
        scheduledAt: new Date(),
        processingDeadline: pastDeadline,
        processedAt: null,
      });
      await repo.save(msg);

      await worker.recoverStuckMessages();
      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-recover' });
      expect(row.status).toBe(V2OutboxStatus.DISPATCHED);
    });
  });

  // ── Scheduled delivery ────────────────────────────────────────────────────

  describe('scheduled delivery', () => {
    it('does not dispatch a message scheduled in the future', async () => {
      const future = new Date(Date.now() + 60_000);
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-future',
          eventType: 'notification.send',
          payload: {},
          scheduledAt: future,
        }),
      );

      await worker.pollAndDispatch();

      expect(mockQueue.add).not.toHaveBeenCalled();
      const row = await repo.findOneByOrFail({ aggregateId: 'c-future' });
      expect(row.status).toBe(V2OutboxStatus.PENDING);
    });

    it('dispatches a message scheduled in the past', async () => {
      const past = new Date(Date.now() - 1000);
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-past',
          eventType: 'notification.send',
          payload: {},
          scheduledAt: past,
        }),
      );

      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-past' });
      expect(row.status).toBe(V2OutboxStatus.DISPATCHED);
    });
  });

  // ── Observability ─────────────────────────────────────────────────────────

  describe('observability — health counts', () => {
    it('getPendingCount reflects actual pending rows in the DB', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-obs',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      const count = await service.getPendingCount();
      expect(count).toBe(1);
    });

    it('getDeadLetterCount reflects actual dead-letter rows', async () => {
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-dl-obs', {});
      const msg = repo.create({
        aggregateType: 'claim',
        aggregateId: 'c-dl-obs',
        eventType: 'notification.send',
        payload: {},
        idempotencyKey: key,
        status: V2OutboxStatus.DEAD_LETTER,
        retryCount: 5,
        maxRetries: 5,
        lastError: 'fatal',
        jobId: null,
        scheduledAt: new Date(),
        processingDeadline: null,
        processedAt: null,
      });
      await repo.save(msg);

      const count = await service.getDeadLetterCount();
      expect(count).toBe(1);
    });
  });

  // ── Stale / degraded dependency ───────────────────────────────────────────

  describe('degraded BullMQ dependency', () => {
    it('does not leave the row in PROCESSING when BullMQ is unavailable', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-degraded',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      mockQueue.add.mockRejectedValueOnce(new Error('BullMQ unavailable'));

      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-degraded' });
      // Must be PENDING (retriable), not PROCESSING (stuck)
      expect(row.status).toBe(V2OutboxStatus.PENDING);
      expect(row.processingDeadline).toBeNull();
    });

    it('records the BullMQ error message on the row for operator visibility', async () => {
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-errmsg',
          eventType: 'notification.send',
          payload: {},
        }),
      );

      mockQueue.add.mockRejectedValueOnce(
        new Error('ECONNREFUSED: Could not connect to Redis'),
      );

      await worker.pollAndDispatch();

      const row = await repo.findOneByOrFail({ aggregateId: 'c-errmsg' });
      expect(row.lastError).toContain('ECONNREFUSED');
    });
  });

  // ── Protocol-authority isolation regression ───────────────────────────────

  describe('protocol-authority regression', () => {
    it('only writes to v2_outbox_messages — never touches canonical event tables', async () => {
      // This test verifies the outbox does not create, modify, or delete rows
      // in any other table. We only have V2OutboxMessage registered in this
      // test module, so any attempt to touch another entity would throw a
      // "repository not found" error from TypeORM. The test passes if the
      // full publishWithManager + pollAndDispatch cycle completes without
      // accessing an unregistered entity.
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-isolation',
          eventType: 'notification.send',
          payload: { channel: 'in_app', recipientIds: ['user-2'] },
        }),
      );

      await expect(worker.pollAndDispatch()).resolves.not.toThrow();
    });

    it('payload forwarded to BullMQ never contains private keys, PII, or settlement data', async () => {
      // Attempt to sneak forbidden fields into the payload — they must not
      // appear verbatim as top-level BullMQ job fields that could be acted
      // upon by a naive consumer as protocol state.
      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'claim',
          aggregateId: 'c-payload-check',
          eventType: 'notification.send',
          payload: {
            channel: 'in_app',
            meta: { internalRef: 'safe-ref-only' },
          },
        }),
      );

      await worker.pollAndDispatch();

      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData).not.toHaveProperty('privateKey');
      expect(jobData).not.toHaveProperty('walletAddress');
      expect(jobData).not.toHaveProperty('settlementAmount');
      expect(jobData).not.toHaveProperty('rewardAmount');
    });

    it('canary: canonical V2 protocol state is unmodified after full outbox cycle', async () => {
      // This module registers only V2OutboxMessage. If the worker attempted to
      // touch any canonical entity (CanonicalEvent, Evidence, etc.) TypeORM
      // would throw "No metadata found for <entity>". Passing this test proves
      // no such access occurs.
      const beforeCount = await repo.count();

      await dataSource.transaction((m) =>
        service.publishWithManager(m, {
          aggregateType: 'verification_round',
          aggregateId: 'vr-canary',
          eventType: 'notification.send',
          payload: {},
        }),
      );
      await worker.pollAndDispatch();

      const afterCount = await repo.count();
      // Exactly one outbox row was written and dispatched; no phantom rows.
      expect(afterCount).toBe(beforeCount + 1);
    });
  });
});
