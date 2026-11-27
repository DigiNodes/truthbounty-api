/**
 * OutboxScheduler — unit tests (PREWAVE-BE-200)
 *
 * Coverage matrix:
 *
 * Per-event jobId correctness
 *   ✓ Each successfully enqueued event receives its own distinct jobId
 *   ✓ First event enqueue failure — later events still persist correct jobIds
 *   ✓ Middle event enqueue failure — surrounding events unaffected
 *   ✓ Last event enqueue failure — preceding events unaffected
 *   ✓ All enqueue failures — no DB updates attempted
 *   ✓ No event is marked DISPATCHED unless its own BullMQ job was confirmed
 *
 * State transitions
 *   ✓ Successful enqueue + DB update → status = DISPATCHED, jobId = confirmed id
 *   ✓ Failed enqueue → row stays PENDING, no jobId written
 *   ✓ DB update with count = 0 (concurrent pod) → no crash, logged as debug
 *   ✓ DB update throws after successful enqueue → orphan logged, no crash
 *
 * Idempotency / crash-safety
 *   ✓ Stable jobId = outbox-<idempotencyKey> is passed to BullMQ
 *   ✓ Re-enqueue on next poll uses same stable jobId (crash-between-enqueue-and-update)
 *
 * Concurrency guard
 *   ✓ Concurrent scheduler.pollOutbox() calls do not overlap within same instance
 *
 * Partial DB update
 *   ✓ One DB update fails mid-batch — remaining rows are still updated
 *
 * Empty batch
 *   ✓ No events found → no enqueue calls, no DB calls beyond the initial findMany
 *
 * Graceful shutdown
 *   ✓ isDraining=true → poll skipped entirely
 *
 * Event type validation
 *   ✓ Invalid eventType format → enqueue fails, event stays PENDING
 *   ✓ BullMQ returns no job ID → enqueue fails, event stays PENDING
 *   ✓ Invalid JSON payload → enqueue fails, event stays PENDING
 */

// Avoid loading the real @libsql native driver adapter transitively through
// prisma.service.ts; unit tests provide their own PrismaService mock via DI.
jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { OutboxScheduler } from './outbox-scheduler.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventCounter = 0;

interface FakeOutboxRow {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: string;
  idempotencyKey: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  jobId: string | null;
  processedAt: Date | null;
}

function makeRow(overrides: Partial<FakeOutboxRow> = {}): FakeOutboxRow {
  eventCounter++;
  return {
    id: `event-${eventCounter}`,
    eventType: 'NOTIFICATION:CLAIM_CREATED',
    aggregateId: `aggregate-${eventCounter}`,
    payload: JSON.stringify({ recipientIds: ['user-1'] }),
    idempotencyKey: `ikey-${eventCounter}`,
    status: 'PENDING',
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    jobId: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as FakeOutboxRow;
}

function buildScheduler(overrides: {
  findMany?: jest.Mock;
  updateMany?: jest.Mock;
  count?: jest.Mock;
  findFirst?: jest.Mock;
  deleteMany?: jest.Mock;
  add?: jest.Mock;
  isDraining?: boolean;
}): {
  scheduler: OutboxScheduler;
  mockOutboxEvent: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
    findFirst: jest.Mock;
    deleteMany: jest.Mock;
  };
  mockQueue: { add: jest.Mock };
  mockShutdown: { isDraining: boolean; runTracked: jest.Mock };
} {
  const mockOutboxEvent = {
    findMany: overrides.findMany ?? jest.fn().mockResolvedValue([]),
    updateMany: overrides.updateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    count: overrides.count ?? jest.fn().mockResolvedValue(0),
    findFirst: overrides.findFirst ?? jest.fn().mockResolvedValue(null),
    deleteMany: overrides.deleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
  };

  const mockPrisma = {
    outboxEvent: mockOutboxEvent,
  };

  const mockQueue = {
    add: overrides.add ?? jest.fn().mockResolvedValue({ id: 'job-default' }),
  };

  const isDraining = overrides.isDraining ?? false;
  const mockShutdown = {
    isDraining,
    runTracked: jest.fn().mockImplementation(
      (_name: string, fn: () => Promise<void>) => fn(),
    ),
  };

  // Directly instantiate — avoids @nestjs/typeorm / NestJS DI in unit tests
  const scheduler = new OutboxScheduler(
    mockPrisma as any,
    mockQueue as any,
    mockShutdown as any,
  );

  return { scheduler, mockOutboxEvent, mockQueue, mockShutdown };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  eventCounter = 0;
});

// -------------------------------------------------------------------------
// Empty batch
// -------------------------------------------------------------------------

describe('OutboxScheduler — empty batch', () => {
  it('makes no enqueue or update calls when there are no pending events', async () => {
    const { scheduler, mockQueue, mockOutboxEvent } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([]),
    });

    await scheduler.pollOutbox();

    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(mockOutboxEvent.updateMany).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// Graceful shutdown
// -------------------------------------------------------------------------

describe('OutboxScheduler — graceful shutdown', () => {
  it('skips the poll entirely when isDraining is true', async () => {
    const { scheduler, mockOutboxEvent } = buildScheduler({ isDraining: true });

    await scheduler.pollOutbox();

    expect(mockOutboxEvent.findMany).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// Per-event jobId correctness
// -------------------------------------------------------------------------

describe('OutboxScheduler — per-event jobId correctness', () => {
  it('stores distinct jobIds on each matching event when all enqueues succeed', async () => {
    const rows = [makeRow(), makeRow(), makeRow()];

    const addMock = jest.fn()
      .mockResolvedValueOnce({ id: 'job-A' })
      .mockResolvedValueOnce({ id: 'job-B' })
      .mockResolvedValueOnce({ id: 'job-C' });

    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue(rows),
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(updateManyMock).toHaveBeenCalledTimes(3);

    const idToJobId = new Map<string, string>(
      updateManyMock.mock.calls.map(([call]: [any]) => [
        call.where.id,
        call.data.jobId,
      ]),
    );

    expect(idToJobId.get(rows[0].id)).toBe('job-A');
    expect(idToJobId.get(rows[1].id)).toBe('job-B');
    expect(idToJobId.get(rows[2].id)).toBe('job-C');
  });

  it('no event is marked DISPATCHED unless its own BullMQ job was confirmed', async () => {
    const row = makeRow();
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([row]),
      add: jest.fn().mockResolvedValue({ id: 'job-X' }),
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    const [call] = updateManyMock.mock.calls[0] as [any];
    expect(call.where).toMatchObject({ id: row.id, status: 'PENDING' });
    expect(call.data.status).toBe('DISPATCHED');
    expect(call.data.jobId).toBe('job-X');
  });

  it('writes the stable idempotencyKey-based jobId to BullMQ add() options', async () => {
    const row = makeRow({ idempotencyKey: 'my-ikey' });
    const addMock = jest.fn().mockResolvedValue({ id: 'outbox-my-ikey' });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([row]),
      add: addMock,
    });

    await scheduler.pollOutbox();

    const addCallOptions = addMock.mock.calls[0][2]; // 3rd arg is options
    expect(addCallOptions.jobId).toBe('outbox-my-ikey');
  });
});

// -------------------------------------------------------------------------
// Enqueue failure permutations
// -------------------------------------------------------------------------

describe('OutboxScheduler — enqueue failure permutations', () => {
  it('first event fails — second and third persist their correct jobIds', async () => {
    const [r1, r2, r3] = [makeRow(), makeRow(), makeRow()];

    const addMock = jest.fn()
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValueOnce({ id: 'job-B' })
      .mockResolvedValueOnce({ id: 'job-C' });

    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([r1, r2, r3]),
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(updateManyMock).toHaveBeenCalledTimes(2);

    const updatedIds = updateManyMock.mock.calls.map(
      ([c]: [any]) => c.where.id,
    );
    expect(updatedIds).not.toContain(r1.id);
    expect(updatedIds).toContain(r2.id);
    expect(updatedIds).toContain(r3.id);

    const idToJobId = new Map<string, string>(
      updateManyMock.mock.calls.map(([c]: [any]) => [c.where.id, c.data.jobId]),
    );
    expect(idToJobId.get(r2.id)).toBe('job-B');
    expect(idToJobId.get(r3.id)).toBe('job-C');
  });

  it('middle event fails — first and third persist their correct jobIds', async () => {
    const [r1, r2, r3] = [makeRow(), makeRow(), makeRow()];

    const addMock = jest.fn()
      .mockResolvedValueOnce({ id: 'job-A' })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ id: 'job-C' });

    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([r1, r2, r3]),
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(updateManyMock).toHaveBeenCalledTimes(2);

    const idToJobId = new Map<string, string>(
      updateManyMock.mock.calls.map(([c]: [any]) => [c.where.id, c.data.jobId]),
    );
    expect(idToJobId.get(r1.id)).toBe('job-A');
    expect(idToJobId.has(r2.id)).toBe(false);
    expect(idToJobId.get(r3.id)).toBe('job-C');
  });

  it('last event fails — first and second persist correct jobIds', async () => {
    const [r1, r2, r3] = [makeRow(), makeRow(), makeRow()];

    const addMock = jest.fn()
      .mockResolvedValueOnce({ id: 'job-A' })
      .mockResolvedValueOnce({ id: 'job-B' })
      .mockRejectedValueOnce(new Error('connection reset'));

    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([r1, r2, r3]),
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(updateManyMock).toHaveBeenCalledTimes(2);

    const idToJobId = new Map<string, string>(
      updateManyMock.mock.calls.map(([c]: [any]) => [c.where.id, c.data.jobId]),
    );
    expect(idToJobId.get(r1.id)).toBe('job-A');
    expect(idToJobId.get(r2.id)).toBe('job-B');
    expect(idToJobId.has(r3.id)).toBe(false);
  });

  it('all enqueue failures — no DB update is attempted', async () => {
    const rows = [makeRow(), makeRow()];
    const updateManyMock = jest.fn();

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue(rows),
      add: jest.fn().mockRejectedValue(new Error('queue down')),
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// Crash between enqueue and DB update (replay safety)
// -------------------------------------------------------------------------

describe('OutboxScheduler — crash-between-enqueue-and-update replay safety', () => {
  it('a failed DB update does not crash the scheduler; remaining events are still persisted', async () => {
    const [r1, r2] = [makeRow(), makeRow()];

    const addMock = jest.fn()
      .mockResolvedValueOnce({ id: 'job-A' })
      .mockResolvedValueOnce({ id: 'job-B' });

    // First DB update throws; second should still run
    const updateManyMock = jest.fn()
      .mockRejectedValueOnce(new Error('DB write error'))
      .mockResolvedValueOnce({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([r1, r2]),
      add: addMock,
      updateMany: updateManyMock,
    });

    await expect(scheduler.pollOutbox()).resolves.not.toThrow();
    expect(updateManyMock).toHaveBeenCalledTimes(2);
  });

  it('re-enqueue on next poll uses the same stable jobId (idempotent replay)', async () => {
    const row = makeRow({ idempotencyKey: 'stable-key' });
    const expectedJobId = 'outbox-stable-key';
    const findManyMock = jest.fn();
    const addMock = jest.fn();
    const updateManyMock = jest.fn();

    // First poll — enqueue succeeds, DB update fails
    findManyMock.mockResolvedValueOnce([row]);
    addMock.mockResolvedValueOnce({ id: expectedJobId });
    updateManyMock.mockRejectedValueOnce(new Error('transient DB error'));

    const { scheduler } = buildScheduler({
      findMany: findManyMock,
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    // Second poll — same event still PENDING, re-enqueued
    findManyMock.mockResolvedValueOnce([row]);
    addMock.mockResolvedValueOnce({ id: expectedJobId });
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    await scheduler.pollOutbox();

    // Both enqueue calls must pass the same stable jobId
    const jobIds = addMock.mock.calls.map((c: any[]) => c[2].jobId);
    expect(jobIds).toEqual([expectedJobId, expectedJobId]);
  });
});

// -------------------------------------------------------------------------
// Concurrent scheduler runs (same pod)
// -------------------------------------------------------------------------

describe('OutboxScheduler — concurrent runs on the same pod', () => {
  it('a second concurrent call is skipped while the first is running', async () => {
    const row = makeRow();

    let releasePoll!: (val: FakeOutboxRow[]) => void;
    const findGate = new Promise<FakeOutboxRow[]>((resolve) => {
      releasePoll = resolve;
    });

    // First findMany hangs; second would return immediately
    const findManyMock = jest.fn()
      .mockReturnValueOnce(findGate)
      .mockResolvedValue([]);

    const addMock = jest.fn().mockResolvedValue({ id: 'job-X' });

    const { scheduler } = buildScheduler({
      findMany: findManyMock,
      add: addMock,
    });

    // Start first poll — blocks on findGate
    const first = scheduler.pollOutbox();
    // Start second poll while first is in flight
    const second = scheduler.pollOutbox();

    releasePoll([row]);

    await Promise.all([first, second]);

    // findMany was only called once (second poll was rejected by isPolling guard)
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------------------------
// Partial DB update mid-batch
// -------------------------------------------------------------------------

describe('OutboxScheduler — partial DB update', () => {
  it('one DB update failure mid-batch does not block other rows', async () => {
    const rows = [makeRow(), makeRow(), makeRow()];

    const addMock = jest.fn()
      .mockResolvedValueOnce({ id: 'job-A' })
      .mockResolvedValueOnce({ id: 'job-B' })
      .mockResolvedValueOnce({ id: 'job-C' });

    // Middle update fails
    const updateManyMock = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue(rows),
      add: addMock,
      updateMany: updateManyMock,
    });

    await expect(scheduler.pollOutbox()).resolves.not.toThrow();
    expect(updateManyMock).toHaveBeenCalledTimes(3);
  });
});

// -------------------------------------------------------------------------
// Concurrent pod race (WHERE status = 'PENDING' guard)
// -------------------------------------------------------------------------

describe('OutboxScheduler — concurrent pod race', () => {
  it('count = 0 from a concurrent pod does not crash the scheduler', async () => {
    const row = makeRow();
    const updateManyMock = jest.fn().mockResolvedValue({ count: 0 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([row]),
      add: jest.fn().mockResolvedValue({ id: 'job-X' }),
      updateMany: updateManyMock,
    });

    await expect(scheduler.pollOutbox()).resolves.not.toThrow();

    const [call] = updateManyMock.mock.calls[0] as [any];
    expect(call.where).toMatchObject({ id: row.id, status: 'PENDING' });
    expect(call.data).toMatchObject({ status: 'DISPATCHED', jobId: 'job-X' });
  });
});

// -------------------------------------------------------------------------
// Event type validation
// -------------------------------------------------------------------------

describe('OutboxScheduler — event type validation', () => {
  it('invalid eventType format causes enqueue failure — event stays PENDING, no DB update', async () => {
    const badRow = makeRow({ eventType: 'INVALID_NO_PREFIX' });
    const addMock = jest.fn();
    const updateManyMock = jest.fn();

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([badRow]),
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(addMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('BullMQ returning no job ID causes enqueue failure — event stays PENDING', async () => {
    const row = makeRow();
    const updateManyMock = jest.fn();

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([row]),
      add: jest.fn().mockResolvedValue({ id: undefined }),
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('invalid JSON payload causes enqueue failure — event stays PENDING', async () => {
    const badRow = makeRow({ payload: 'not-json{{{' });
    const addMock = jest.fn();
    const updateManyMock = jest.fn();

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([badRow]),
      add: addMock,
      updateMany: updateManyMock,
    });

    await scheduler.pollOutbox();

    expect(addMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// processedAt timestamp
// -------------------------------------------------------------------------

describe('OutboxScheduler — processedAt timestamp', () => {
  it('sets processedAt to a Date on successful dispatch', async () => {
    const row = makeRow();
    const updateManyMock = jest.fn().mockResolvedValue({ count: 1 });

    const { scheduler } = buildScheduler({
      findMany: jest.fn().mockResolvedValue([row]),
      add: jest.fn().mockResolvedValue({ id: 'job-X' }),
      updateMany: updateManyMock,
    });

    const before = new Date();
    await scheduler.pollOutbox();
    const after = new Date();

    const [call] = updateManyMock.mock.calls[0] as [any];
    expect(call.data.processedAt).toBeInstanceOf(Date);
    expect((call.data.processedAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect((call.data.processedAt as Date).getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
