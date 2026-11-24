import { PublicErrorCode } from '../common/constants/error-codes';
import { InMemoryOperationsAuditStore } from './operations-audit.store';
import { OperationsQueueSource } from './operations-queue.source';
import { OperationsService } from './operations.service';
import {
  AuthoritySource,
  DuplicationRisk,
  FreshnessState,
  OperationalCapability,
  OperationalImpact,
  OperationalQueueItem,
  QueueItemStatus,
  RetryDenialReason,
} from './operations.types';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function makeItem(
  overrides: Partial<OperationalQueueItem> = {},
): OperationalQueueItem {
  return {
    id: 'queue-001',
    releaseId: 'v2.0.0-sepolia',
    capability: OperationalCapability.RETRY_SUBMIT,
    authoritySource: AuthoritySource.SYSTEM,
    authorityExpiresAt: null,
    status: QueueItemStatus.FAILED,
    impact: OperationalImpact.MEDIUM,
    duplicationRisk: DuplicationRisk.IDEMPOTENT_REPLAY,
    freshness: FreshnessState.FRESH,
    attempts: 1,
    maxAttempts: 5,
    retryable: true,
    version: '100',
    updatedAt: new Date(0).toISOString(),
    summary: 'outbox event: notification.send',
    ...overrides,
  };
}

class FakeSource implements OperationsQueueSource {
  items = new Map<string, OperationalQueueItem>();
  retry = jest.fn(async () => ({
    replayed: 1,
    skipped: 0,
    failed: 0,
    detail: null as string | null,
  }));

  async list(): Promise<OperationalQueueItem[]> {
    return [...this.items.values()];
  }

  async get(id: string): Promise<OperationalQueueItem | null> {
    return this.items.get(id) ?? null;
  }
}

function build() {
  const source = new FakeSource();
  source.items.set('queue-001', makeItem());
  const auditStore = new InMemoryOperationsAuditStore();
  const service = new OperationsService(source, auditStore);
  return { source, auditStore, service };
}

async function tokenFor(service: OperationsService, id = 'queue-001') {
  return (await service.getRetryEligibility(id)).preconditionToken;
}

describe('OperationsService (UX-BE-004)', () => {
  it('lists the queue with status counts', async () => {
    const { source, service } = build();
    source.items.set(
      'queue-002',
      makeItem({ id: 'queue-002', status: QueueItemStatus.COMPLETED }),
    );

    const summary = await service.listQueue();

    expect(summary.total).toBe(2);
    expect(summary.countsByStatus[QueueItemStatus.FAILED]).toBe(1);
    expect(summary.countsByStatus[QueueItemStatus.COMPLETED]).toBe(1);
    expect(summary.releaseId).toBe('v2.0.0-sepolia');
  });

  it('reports retry eligibility without guessing', async () => {
    const { source, service } = build();
    source.items.set(
      'queue-003',
      makeItem({ id: 'queue-003', status: QueueItemStatus.COMPLETED }),
    );

    const eligible = await service.getRetryEligibility('queue-001');
    const completed = await service.getRetryEligibility('queue-003');

    expect(eligible.eligible).toBe(true);
    expect(eligible.reason).toBeNull();
    expect(eligible.attemptsRemaining).toBe(4);
    expect(eligible.preconditionToken).toEqual(expect.any(String));
    expect(completed.eligible).toBe(false);
    expect(completed.reason).toBe(RetryDenialReason.ALREADY_COMPLETED);
  });

  describe('authority is revalidated on every request (fail closed)', () => {
    it('denies a missing or mismatched capability', async () => {
      const { service } = build();
      const token = await tokenFor(service);

      await expect(
        service.submitRetry({
          id: 'queue-001',
          preconditionToken: token,
          authorityExpiresAt: FUTURE,
        }),
      ).rejects.toMatchObject({
        status: 403,
        errorCode: PublicErrorCode.FORBIDDEN,
      });

      await expect(
        service.submitRetry({
          id: 'queue-001',
          preconditionToken: token,
          authorityCapability: OperationalCapability.QUEUE_READ,
          authorityExpiresAt: FUTURE,
        }),
      ).rejects.toMatchObject({
        status: 403,
        errorCode: PublicErrorCode.FORBIDDEN,
      });
    });

    it('fails closed on a missing, stale or ambiguous expiry', async () => {
      const { service } = build();
      const token = await tokenFor(service);
      const base = {
        id: 'queue-001',
        preconditionToken: token,
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
      };

      for (const authorityExpiresAt of [undefined, PAST, 'not-a-date']) {
        await expect(
          service.submitRetry({ ...base, authorityExpiresAt }),
        ).rejects.toMatchObject({
          status: 403,
          errorCode: PublicErrorCode.STALE_AUTHORITY,
        });
      }
    });
  });

  it('rejects a stale or missing precondition token', async () => {
    const { service } = build();

    await expect(
      service.submitRetry({
        id: 'queue-001',
        preconditionToken: 'stale-token',
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: FUTURE,
      }),
    ).rejects.toMatchObject({
      status: 409,
      errorCode: PublicErrorCode.STALE_PRECONDITION,
    });
  });

  it('is idempotent: a duplicate key replays the original outcome exactly once', async () => {
    const { source, service } = build();
    const token = await tokenFor(service);
    const input = {
      id: 'queue-001',
      preconditionToken: token,
      idempotencyKey: 'key-1',
      authorityCapability: OperationalCapability.RETRY_SUBMIT,
      authorityExpiresAt: FUTURE,
    };

    const first = await service.submitRetry(input);
    const second = await service.submitRetry(input);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.auditId).toBe(first.auditId);
    expect(source.retry).toHaveBeenCalledTimes(1);
  });

  it('conflicts when an idempotency key is reused for a different item', async () => {
    const { source, service } = build();
    source.items.set('queue-002', makeItem({ id: 'queue-002' }));
    const token1 = await tokenFor(service, 'queue-001');
    const token2 = await tokenFor(service, 'queue-002');

    await service.submitRetry({
      id: 'queue-001',
      preconditionToken: token1,
      idempotencyKey: 'key-2',
      authorityCapability: OperationalCapability.RETRY_SUBMIT,
      authorityExpiresAt: FUTURE,
    });

    await expect(
      service.submitRetry({
        id: 'queue-002',
        preconditionToken: token2,
        idempotencyKey: 'key-2',
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: FUTURE,
      }),
    ).rejects.toMatchObject({
      status: 409,
      errorCode: PublicErrorCode.CONFLICT,
    });
  });

  it('refuses already-completed, quarantined and unsafe items', async () => {
    const { source, service } = build();
    source.items.set(
      'done',
      makeItem({ id: 'done', status: QueueItemStatus.COMPLETED }),
    );
    source.items.set(
      'quarantined',
      makeItem({ id: 'quarantined', status: QueueItemStatus.QUARANTINED }),
    );
    source.items.set(
      'dup-risk',
      makeItem({ id: 'dup-risk', duplicationRisk: DuplicationRisk.POSSIBLE }),
    );

    const cases: Array<[string, PublicErrorCode]> = [
      ['done', PublicErrorCode.ALREADY_COMPLETED],
      ['quarantined', PublicErrorCode.UNSAFE_TO_RETRY],
      ['dup-risk', PublicErrorCode.UNSAFE_TO_RETRY],
    ];

    for (const [id, code] of cases) {
      const token = await tokenFor(service, id);
      await expect(
        service.submitRetry({
          id,
          preconditionToken: token,
          authorityCapability: OperationalCapability.RETRY_SUBMIT,
          authorityExpiresAt: FUTURE,
        }),
      ).rejects.toMatchObject({ status: 409, errorCode: code });
    }
  });

  it('refuses a non-retryable item unless forced', async () => {
    const source = new FakeSource();
    source.items.set('nr', makeItem({ id: 'nr', retryable: false }));
    const service = new OperationsService(
      source,
      new InMemoryOperationsAuditStore(),
    );
    const token = await tokenFor(service, 'nr');

    await expect(
      service.submitRetry({
        id: 'nr',
        preconditionToken: token,
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: FUTURE,
      }),
    ).rejects.toMatchObject({
      status: 409,
      errorCode: PublicErrorCode.NOT_RETRYABLE,
    });

    const result = await service.submitRetry({
      id: 'nr',
      preconditionToken: token,
      authorityCapability: OperationalCapability.RETRY_SUBMIT,
      authorityExpiresAt: FUTURE,
      force: true,
    });
    expect(result.accepted).toBe(true);
    expect(source.retry).toHaveBeenCalledTimes(1);
  });

  it('maps a dependency failure to an unavailable response', async () => {
    const { source, service } = build();
    source.retry.mockRejectedValueOnce(new Error('redis down'));
    const token = await tokenFor(service);

    await expect(
      service.submitRetry({
        id: 'queue-001',
        preconditionToken: token,
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: FUTURE,
      }),
    ).rejects.toMatchObject({
      status: 503,
      errorCode: PublicErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });

  it('persists a sanitized audit record for accepted and rejected requests', async () => {
    const { service } = build();
    const token = await tokenFor(service);

    const accepted = await service.submitRetry({
      id: 'queue-001',
      preconditionToken: token,
      authorityCapability: OperationalCapability.RETRY_SUBMIT,
      authorityExpiresAt: FUTURE,
      actorId: 'admin-1',
    });

    const record = await service.getAuditRecord(accepted.auditId);
    expect(record.outcome).toBe('accepted');
    expect(record.actorId).toBe('admin-1');
    expect(record.subjectId).toBe('queue-001');
    expect(JSON.stringify(record)).not.toMatch(
      /authorization|secret|bearer|private[-_ ]?key/i,
    );

    await expect(
      service.submitRetry({
        id: 'queue-001',
        preconditionToken: 'stale',
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: FUTURE,
      }),
    ).rejects.toMatchObject({ auditId: expect.any(String) });

    let rejectedAuditId = '';
    try {
      await service.submitRetry({
        id: 'queue-001',
        preconditionToken: 'stale',
        authorityCapability: OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: FUTURE,
      });
    } catch (error) {
      rejectedAuditId = (error as { auditId: string }).auditId;
    }
    const rejected = await service.getAuditRecord(rejectedAuditId);
    expect(rejected.outcome).toBe('rejected');
  });
});
