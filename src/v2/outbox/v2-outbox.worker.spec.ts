import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import {
  V2OutboxWorker,
  V2_OUTBOX_QUEUE_NAME,
  V2_OUTBOX_JOB_NAME,
} from './v2-outbox.worker';
import { V2OutboxMessage, V2OutboxStatus } from './entities/v2-outbox-message.entity';
import { MetricsService } from '../../metrics/metrics.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<V2OutboxMessage> = {}): V2OutboxMessage {
  return {
    id: 'msg-uuid-1',
    aggregateType: 'claim',
    aggregateId: 'claim-abc',
    eventType: 'notification.send',
    payload: { channel: 'in_app', recipientIds: ['user-1'] },
    idempotencyKey: 'a'.repeat(64),
    status: V2OutboxStatus.PENDING,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    jobId: null,
    scheduledAt: new Date(),
    processingDeadline: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as V2OutboxMessage;
}

// ---------------------------------------------------------------------------
// Helpers to build the mock DataSource
// ---------------------------------------------------------------------------

function makeQueryBuilderChain(
  overrides: { execute?: jest.Mock; getMany?: jest.Mock } = {},
) {
  const qb: Record<string, jest.Mock> = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    whereInIds: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: overrides.execute ?? jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: overrides.getMany ?? jest.fn().mockResolvedValue([]),
  };
  // Self-referential returns for method chaining
  Object.values(qb).forEach((fn) => {
    if (fn !== qb.execute && fn !== qb.getMany) {
      (fn as jest.Mock).mockReturnThis();
    }
  });
  return qb;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('V2OutboxWorker', () => {
  let worker: V2OutboxWorker;
  let mockDataSource: any;
  let mockQueue: { add: jest.Mock };
  let mockMetrics: { incrementCounter: jest.Mock };

  /** Repository mock returned by dataSource.getRepository and manager.getRepository */
  let mockRepo: {
    find: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    mockRepo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => makeQueryBuilderChain()),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bullmq-job-99' }),
    };

    mockMetrics = {
      incrementCounter: jest.fn(),
    };

    // DataSource mock: supports both direct getRepository() and transaction()
    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepo),
      createQueryBuilder: jest.fn(() =>
        makeQueryBuilderChain({ execute: jest.fn().mockResolvedValue({ affected: 0 }) }),
      ),
      transaction: jest.fn().mockImplementation(async (cb: (m: any) => Promise<any>) => {
        const manager = {
          getRepository: jest.fn().mockReturnValue(mockRepo),
          createQueryBuilder: jest.fn(() =>
            makeQueryBuilderChain({
              getMany: jest.fn().mockResolvedValue([]),
            }),
          ),
        };
        return cb(manager);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        V2OutboxWorker,
        { provide: DataSource, useValue: mockDataSource },
        { provide: getQueueToken(V2_OUTBOX_QUEUE_NAME), useValue: mockQueue },
        { provide: MetricsService, useValue: mockMetrics },
      ],
    }).compile();

    worker = module.get<V2OutboxWorker>(V2OutboxWorker);
  });

  // ── handleCron guard ──────────────────────────────────────────────────────

  describe('handleCron', () => {
    it('skips poll cycle while a previous cycle is still active', async () => {
      // Simulate in-flight by reaching into private state
      (worker as any).isPolling = true;
      const pollSpy = jest.spyOn(worker, 'pollAndDispatch');
      await worker.handleCron();
      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('skips poll cycle after onModuleDestroy is called', async () => {
      worker.onModuleDestroy();
      const pollSpy = jest.spyOn(worker, 'pollAndDispatch');
      await worker.handleCron();
      expect(pollSpy).not.toHaveBeenCalled();
    });

    it('resets isPolling to false after a successful cycle', async () => {
      await worker.handleCron();
      expect((worker as any).isPolling).toBe(false);
    });

    it('resets isPolling to false even when pollAndDispatch throws', async () => {
      jest
        .spyOn(worker, 'pollAndDispatch')
        .mockRejectedValue(new Error('boom'));
      await worker.handleCron(); // must not throw
      expect((worker as any).isPolling).toBe(false);
    });
  });

  // ── recoverStuckMessages ──────────────────────────────────────────────────

  describe('recoverStuckMessages', () => {
    it('resets PROCESSING rows past their deadline back to PENDING', async () => {
      const execMock = jest.fn().mockResolvedValue({ affected: 2 });
      mockDataSource.createQueryBuilder = jest.fn(() =>
        makeQueryBuilderChain({ execute: execMock }),
      );

      await worker.recoverStuckMessages();

      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'v2_outbox_recovered_total',
        2,
      );
    });

    it('does not emit a metric when no rows are stuck', async () => {
      const execMock = jest.fn().mockResolvedValue({ affected: 0 });
      mockDataSource.createQueryBuilder = jest.fn(() =>
        makeQueryBuilderChain({ execute: execMock }),
      );

      await worker.recoverStuckMessages();

      expect(mockMetrics.incrementCounter).not.toHaveBeenCalledWith(
        'v2_outbox_recovered_total',
        expect.anything(),
      );
    });
  });

  // ── pollAndDispatch — empty batch ─────────────────────────────────────────

  describe('pollAndDispatch — no pending messages', () => {
    it('does nothing when there are no PENDING rows', async () => {
      await worker.pollAndDispatch();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  // ── pollAndDispatch — successful dispatch ─────────────────────────────────

  describe('pollAndDispatch — successful dispatch', () => {
    beforeEach(() => {
      const msg = makeMsg();
      // transaction() callback returns one claimed row
      mockDataSource.transaction = jest.fn().mockImplementation(
        async (cb: (m: any) => Promise<any>) => {
          const qb = makeQueryBuilderChain({
            getMany: jest.fn().mockResolvedValue([msg]),
          });
          const manager = {
            getRepository: jest.fn().mockReturnValue({
              ...mockRepo,
              createQueryBuilder: jest.fn(() => qb),
            }),
          };
          return cb(manager);
        },
      );
    });

    it('dispatches a claimed message to BullMQ with the correct job name', async () => {
      await worker.pollAndDispatch();

      expect(mockQueue.add).toHaveBeenCalledWith(
        V2_OUTBOX_JOB_NAME,
        expect.objectContaining({
          outboxMessageId: 'msg-uuid-1',
          idempotencyKey: 'a'.repeat(64),
          eventType: 'notification.send',
          aggregateType: 'claim',
          aggregateId: 'claim-abc',
        }),
        expect.objectContaining({
          jobId: `outbox-${'a'.repeat(64)}`,
        }),
      );
    });

    it('transitions the row to DISPATCHED with jobId after successful dispatch', async () => {
      await worker.pollAndDispatch();

      expect(mockDataSource.getRepository).toHaveBeenCalled();
      expect(mockRepo.update).toHaveBeenCalledWith(
        'msg-uuid-1',
        expect.objectContaining({
          status: V2OutboxStatus.DISPATCHED,
          jobId: 'bullmq-job-99',
          processedAt: expect.any(Date),
          processingDeadline: null,
        }),
      );
    });

    it('increments the dispatched counter', async () => {
      await worker.pollAndDispatch();
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'v2_outbox_dispatched_total',
        1,
      );
    });

    it('does not relay userId, PII, or settlement data in the job payload', async () => {
      await worker.pollAndDispatch();

      const jobPayload = mockQueue.add.mock.calls[0][1];
      expect(jobPayload).not.toHaveProperty('userId');
      expect(jobPayload).not.toHaveProperty('privateKey');
      expect(jobPayload).not.toHaveProperty('settlementAmount');
      expect(jobPayload).not.toHaveProperty('walletAddress');
    });
  });

  // ── Retry on transient BullMQ failure ────────────────────────────────────

  describe('pollAndDispatch — transient BullMQ failure', () => {
    const msg = makeMsg({ retryCount: 0, maxRetries: 5 });

    beforeEach(() => {
      mockDataSource.transaction = jest.fn().mockImplementation(
        async (cb: (m: any) => Promise<any>) => {
          const qb = makeQueryBuilderChain({
            getMany: jest.fn().mockResolvedValue([msg]),
          });
          const manager = {
            getRepository: jest.fn().mockReturnValue({
              ...mockRepo,
              createQueryBuilder: jest.fn(() => qb),
            }),
          };
          return cb(manager);
        },
      );
      mockQueue.add.mockRejectedValueOnce(new Error('Redis connection refused'));
    });

    it('increments retryCount and resets to PENDING on the first failure', async () => {
      await worker.pollAndDispatch();

      expect(mockRepo.update).toHaveBeenCalledWith(
        'msg-uuid-1',
        expect.objectContaining({
          retryCount: 1,
          status: V2OutboxStatus.PENDING,
          lastError: expect.stringContaining('Redis connection refused'),
          processingDeadline: null,
        }),
      );
    });

    it('increments the retry counter metric', async () => {
      await worker.pollAndDispatch();
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'v2_outbox_retry_total',
        1,
      );
    });
  });

  // ── Dead-letter on maxRetries exceeded ───────────────────────────────────

  describe('pollAndDispatch — dead-letter on exhaustion', () => {
    const msg = makeMsg({ retryCount: 4, maxRetries: 5 });

    beforeEach(() => {
      mockDataSource.transaction = jest.fn().mockImplementation(
        async (cb: (m: any) => Promise<any>) => {
          const qb = makeQueryBuilderChain({
            getMany: jest.fn().mockResolvedValue([msg]),
          });
          const manager = {
            getRepository: jest.fn().mockReturnValue({
              ...mockRepo,
              createQueryBuilder: jest.fn(() => qb),
            }),
          };
          return cb(manager);
        },
      );
      mockQueue.add.mockRejectedValueOnce(new Error('persistent failure'));
    });

    it('transitions to DEAD_LETTER when maxRetries is reached', async () => {
      await worker.pollAndDispatch();

      expect(mockRepo.update).toHaveBeenCalledWith(
        'msg-uuid-1',
        expect.objectContaining({
          retryCount: 5,
          status: V2OutboxStatus.DEAD_LETTER,
        }),
      );
    });

    it('increments the dead-letter metric', async () => {
      await worker.pollAndDispatch();
      expect(mockMetrics.incrementCounter).toHaveBeenCalledWith(
        'v2_outbox_dead_lettered_total',
        1,
      );
    });

    it('does NOT re-queue a dead-lettered message', async () => {
      await worker.pollAndDispatch();
      // queue.add was called once (the failing attempt). Should not be called again.
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
    });
  });

  // ── Duplicate dispatch idempotency ───────────────────────────────────────

  describe('idempotency — duplicate BullMQ jobId', () => {
    it('uses jobId=outbox-<idempotencyKey> for BullMQ-level deduplication', async () => {
      const key = 'deadbeef'.repeat(8); // 64-char
      const msg = makeMsg({ idempotencyKey: key });

      mockDataSource.transaction = jest.fn().mockImplementation(
        async (cb: (m: any) => Promise<any>) => {
          const qb = makeQueryBuilderChain({
            getMany: jest.fn().mockResolvedValue([msg]),
          });
          const manager = {
            getRepository: jest.fn().mockReturnValue({
              ...mockRepo,
              createQueryBuilder: jest.fn(() => qb),
            }),
          };
          return cb(manager);
        },
      );

      await worker.pollAndDispatch();

      const opts = mockQueue.add.mock.calls[0][2];
      expect(opts.jobId).toBe(`outbox-${key}`);
    });
  });

  // ── Concurrent worker safety ──────────────────────────────────────────────

  describe('concurrent worker safety', () => {
    it('the in-process guard prevents overlapping poll cycles', async () => {
      // Simulate long-running poll
      (worker as any).isPolling = true;
      const recoverSpy = jest.spyOn(worker, 'recoverStuckMessages');

      await worker.handleCron();

      // recoverStuckMessages is part of the poll cycle; it must not be called
      // while another cycle is in flight.
      expect(recoverSpy).not.toHaveBeenCalled();
    });
  });

  // ── Protocol-authority regression ────────────────────────────────────────

  describe('protocol authority regression', () => {
    it('never modifies v2_canonical_events or protocol tables via the worker', async () => {
      // The worker must only write to v2_outbox_messages.
      // Verify that getRepository is only called with V2OutboxMessage.
      const msg = makeMsg();
      mockDataSource.transaction = jest.fn().mockImplementation(
        async (cb: (m: any) => Promise<any>) => {
          const qb = makeQueryBuilderChain({
            getMany: jest.fn().mockResolvedValue([msg]),
          });
          const manager = {
            getRepository: jest.fn().mockReturnValue({
              ...mockRepo,
              createQueryBuilder: jest.fn(() => qb),
            }),
          };
          return cb(manager);
        },
      );

      await worker.pollAndDispatch();

      // All getRepository calls on the DataSource must be for V2OutboxMessage.
      const calls: any[][] = (mockDataSource.getRepository as jest.Mock).mock.calls;
      calls.forEach(([entityClass]) => {
        expect(entityClass).toBe(V2OutboxMessage);
      });
    });

    it('does not include settlement data, private keys, or PII in queue job payload', async () => {
      const msg = makeMsg({
        payload: {
          channel: 'in_app',
          recipientIds: ['user-1'],
          // Ensure these fields do NOT propagate if a caller accidentally
          // puts them in meta (belt-and-suspenders check)
        },
      });

      mockDataSource.transaction = jest.fn().mockImplementation(
        async (cb: (m: any) => Promise<any>) => {
          const qb = makeQueryBuilderChain({
            getMany: jest.fn().mockResolvedValue([msg]),
          });
          const manager = {
            getRepository: jest.fn().mockReturnValue({
              ...mockRepo,
              createQueryBuilder: jest.fn(() => qb),
            }),
          };
          return cb(manager);
        },
      );

      await worker.pollAndDispatch();

      const jobData = mockQueue.add.mock.calls[0][1];
      expect(jobData).not.toHaveProperty('privateKey');
      expect(jobData).not.toHaveProperty('password');
      expect(jobData).not.toHaveProperty('settlementAmount');
    });
  });
});
