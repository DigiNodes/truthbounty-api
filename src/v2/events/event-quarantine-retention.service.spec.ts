import { EventQuarantineRetentionService } from './event-quarantine-retention.service';
import { QuarantineStatus } from './entities/event-quarantine.entity';
import { GracefulShutdownService } from '../../common/lifecycle/graceful-shutdown.service';

function build(days: unknown = 90, affected = 2) {
  const repo = {
    delete: jest.fn().mockResolvedValue({ affected }),
  };
  const config = { get: jest.fn().mockReturnValue(days) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new EventQuarantineRetentionService(
    repo as never,
    config as never,
    new GracefulShutdownService(),
    audit as never,
  );
  return { service, repo, audit };
}

describe('EventQuarantineRetentionService (PREWAVE-BE-053)', () => {
  it('deletes only replayed rows past their retention window', async () => {
    const { service, repo, audit } = build(90, 3);
    const now = new Date('2026-04-01T00:00:00Z');

    const removed = await service.runRetentionCleanup(now);

    expect(removed).toBe(3);
    const criteria = repo.delete.mock.calls[0][0];
    expect(criteria.status).toBe(QuarantineStatus.REPLAYED);
    expect(criteria.retentionUntil).toBeDefined();
    // Never deletes `open` rows: the status criterion is terminal-only.
    expect(criteria.status).not.toBe(QuarantineStatus.OPEN);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'EVENT_QUARANTINE_RETENTION',
        metadata: expect.objectContaining({ removed: 3 }),
      }),
    );
  });

  it('falls back to the default window for an invalid configuration', async () => {
    const { service, repo } = build(0, 0);
    const now = new Date('2026-04-01T00:00:00Z');

    await service.runRetentionCleanup(now);

    const criteria = repo.delete.mock.calls[0][0];
    // 90-day default: cutoff is 90 days before `now`.
    const expectedCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(criteria.retentionUntil.value.getTime()).toBe(
      expectedCutoff.getTime(),
    );
  });

  it('is idempotent when nothing is eligible', async () => {
    const { service } = build(90, 0);
    await expect(service.runRetentionCleanup()).resolves.toBe(0);
  });
});