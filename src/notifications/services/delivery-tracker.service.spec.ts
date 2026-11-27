import { DeliveryTracker } from './delivery-tracker.service';
import {
  DeliveryChannel,
  DeliveryStatus,
} from '../interfaces/notification.types';
import { DEFAULT_CLAIM_TTL_MS } from '../delivery/delivery-claim';

class FakeDeliveryHistoryRepository {
  rows: any[] = [];
  private sequence = 0;

  async insert(row: Record<string, unknown>): Promise<void> {
    if (
      typeof row.idempotencyKey === 'string' &&
      this.rows.some(
        (existing) => existing.idempotencyKey === row.idempotencyKey,
      )
    ) {
      throw { code: '23505', message: 'duplicate key value' };
    }
    this.rows.push({ ...row, id: `row-${++this.sequence}` });
  }

  async findOne(options: { where: Record<string, unknown> }): Promise<any> {
    return (
      this.rows.find((row) =>
        Object.entries(options.where).every(([key, value]) =>
          value == null ? row[key] == null : row[key] === value,
        ),
      ) ?? null
    );
  }

  async update(
    criteria: Record<string, unknown>,
    partial: Record<string, unknown>,
  ): Promise<{ affected: number }> {
    const matches = this.rows.filter((row) =>
      Object.entries(criteria).every(([key, value]) =>
        value == null ? row[key] == null : row[key] === value,
      ),
    );
    for (const row of matches) {
      Object.assign(row, partial);
    }
    return { affected: matches.length };
  }
}

function createRedis(available: boolean) {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
    setnx: jest.fn().mockResolvedValue(available),
    del: jest.fn().mockResolvedValue(true),
  };
}

describe('DeliveryTracker durable idempotency claims (PREWAVE-BE-128)', () => {
  const context = {
    idempotencyKey: 'sha256-delivery-key',
    notificationId: 'notification-1',
    eventType: 'claim.created',
    aggregateId: 'claim-1',
    recipientId: 'user-1',
    channel: DeliveryChannel.EMAIL,
  };

  let repository: FakeDeliveryHistoryRepository;
  let redisAvailable: ReturnType<typeof createRedis>;
  let redisDown: ReturnType<typeof createRedis>;

  beforeEach(() => {
    repository = new FakeDeliveryHistoryRepository();
    redisAvailable = createRedis(true);
    redisDown = createRedis(false);
  });

  it('lets only one of two racing workers claim with Redis available', async () => {
    const workerA = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    const workerB = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );

    const results = await Promise.all([
      workerA.checkIdempotency(context),
      workerB.checkIdempotency(context),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0].status).toBe(DeliveryStatus.PROCESSING);
  });

  it('lets only one of two racing workers claim when Redis SETNX fails', async () => {
    const workerA = new DeliveryTracker(repository as any, redisDown as any);
    const workerB = new DeliveryTracker(repository as any, redisDown as any);

    const results = await Promise.all([
      workerA.checkIdempotency(context),
      workerB.checkIdempotency(context),
    ]);

    expect(redisDown.setnx).toHaveBeenCalledTimes(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(repository.rows).toHaveLength(1);
  });

  it('does not allow a second send after a crash before the provider call until the lease expires', async () => {
    const workerA = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    const workerB = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );

    expect(await workerA.checkIdempotency(context)).toBe(true);
    expect(await workerB.checkIdempotency(context)).toBe(false);

    repository.rows[0].claimExpiresAt = new Date(Date.now() - 1);

    expect(await workerB.checkIdempotency(context)).toBe(true);
    expect(repository.rows[0].status).toBe(DeliveryStatus.PROCESSING);
  });

  it('recovers an unconfirmed provider outcome only after the uncertainty lease, with fencing', async () => {
    const workerA = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    const workerB = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );

    expect(await workerA.checkIdempotency(context)).toBe(true);
    await workerA.markProviderOutcomeUncertain(
      context.notificationId!,
      context.channel,
      context.idempotencyKey!,
      'provider timeout',
    );

    expect(repository.rows[0].providerUnconfirmed).toBe(true);
    expect(await workerB.checkIdempotency(context)).toBe(false);

    repository.rows[0].claimExpiresAt = new Date(Date.now() - 1);
    expect(await workerB.checkIdempotency(context)).toBe(true);

    await workerB.recordDelivery(
      context.notificationId!,
      context.recipientId!,
      context.channel,
      context.idempotencyKey!,
    );

    expect(repository.rows[0].status).toBe(DeliveryStatus.DELIVERED);
    expect(repository.rows[0].providerUnconfirmed).toBe(false);
  });

  it('suppresses retries after a confirmed delivery', async () => {
    const worker = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    expect(await worker.checkIdempotency(context)).toBe(true);

    await worker.recordDelivery(
      context.notificationId!,
      context.recipientId!,
      context.channel,
      context.idempotencyKey!,
    );

    const retryWorker = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    expect(await retryWorker.checkIdempotency(context)).toBe(false);
    expect(repository.rows).toHaveLength(1);
  });

  it('re-claims a failed attempt according to the retry policy', async () => {
    const workerA = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    const workerB = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );

    expect(await workerA.checkIdempotency(context)).toBe(true);
    await workerA.recordFailure(
      context.notificationId!,
      context.channel,
      'provider rejected',
      context.idempotencyKey!,
      0,
      { source: 'test' },
    );

    expect(repository.rows[0].status).toBe(DeliveryStatus.FAILED);
    expect(await workerB.checkIdempotency(context)).toBe(true);
    expect(repository.rows[0].retryAttempts).toBe(0);
  });

  it('uses the default 60s crash-recovery lease', async () => {
    const worker = new DeliveryTracker(
      repository as any,
      redisAvailable as any,
    );
    const before = Date.now();
    await worker.checkIdempotency(context);
    const after = Date.now();

    const expiry = repository.rows[0].claimExpiresAt.getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_CLAIM_TTL_MS);
    expect(expiry).toBeLessThanOrEqual(after + DEFAULT_CLAIM_TTL_MS);
  });
});
