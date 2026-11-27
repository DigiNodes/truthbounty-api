import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AdminAuditService } from './admin-audit.service';
import {
  AdminActionCategory, AdminActionType, AdminAuditLogInput, AdminAuditSeverity,
} from '../admin-audit.types';
import { AdminAuditHead } from '../entities/admin-audit-head.entity';
import { AdminAuditLog } from '../entities/admin-audit-log.entity';

const context = (): AdminAuditLogInput => ({
  actorId: '00000000-0000-4000-8000-000000000001',
  actorType: 'user',
  action: AdminActionType.RATE_LIMIT_OVERRIDE,
  actionCategory: AdminActionCategory.CONFIGURATION,
  targetType: 'ai_budget_override',
  targetId: '00000000-0000-4000-8000-000000000002',
  capability: 'ai_budget.override.create:OPS-818',
  authoritySource: 'policy',
  authorityReference: '00000000-0000-4000-8000-000000000001',
  requestReference: '00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  outcome: 'attempted',
});

function harness(retention?: unknown) {
  const head = Object.freeze({ id: 1, lastSequence: '6', lastHash: 'old-hash' });
  const manager = {
    findOneOrFail: jest.fn().mockResolvedValue(head),
    getRepository: jest.fn(() => ({
      createQueryBuilder: () => ({
        where: () => ({ getOne: async () => null }),
      }),
    })),
    query: jest.fn().mockResolvedValue([{ timestamp: new Date('2026-11-21T12:00:00Z') }]),
    create: jest.fn((entity: new () => object, value: object) =>
      Object.assign(new entity(), value)),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const source = {
    options: { type: 'postgres' },
    transaction: jest.fn(async (work: (tx: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager)),
  } as unknown as DataSource;
  const config = new ConfigService({ ADMIN_AUDIT_RETENTION_DAYS: retention });
  return { manager, head, service: new AdminAuditService(source, config) };
}

describe('durable audit required by AI budget overrides', () => {
  it('locks the persisted chain head before sampling database time and appending', async () => {
    const { manager, service } = harness();
    await service.log(context());

    expect(manager.findOneOrFail).toHaveBeenCalledWith(AdminAuditHead, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
    expect(manager.query).toHaveBeenCalledWith('SELECT clock_timestamp() AS timestamp');
    expect(manager.findOneOrFail.mock.invocationCallOrder[0])
      .toBeLessThan(manager.query.mock.invocationCallOrder[0]);
    expect(manager.query.mock.invocationCallOrder[0])
      .toBeLessThan(manager.save.mock.invocationCallOrder[0]);
  });

  it('persists server timestamp, retention and severity without mutating the head', async () => {
    const { manager, head, service } = harness(90);
    const eventId = await service.log({
      ...context(),
      timestamp: new Date('2000-01-01T00:00:00Z'),
      retentionUntil: new Date('2000-01-02T00:00:00Z'),
    } as AdminAuditLogInput);

    const row = manager.save.mock.calls[0][0] as AdminAuditLog;
    expect(row.timestamp.toISOString()).toBe('2026-11-21T12:00:00.000Z');
    expect(row.retentionUntil.getTime() - row.timestamp.getTime())
      .toBe(90 * 86400000);
    expect(row.severity).toBe(AdminAuditSeverity.MEDIUM);
    expect(row.eventId).toBe(eventId);
    expect(row.chainSequence).toBe('7');
    expect(row.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manager.save.mock.calls[1][0]).toMatchObject({
      id: 1, lastSequence: '7', lastHash: row.integrityHash,
    });
    expect(manager.save.mock.calls[1][0]).not.toBe(head);
    expect(head).toEqual({ id: 1, lastSequence: '6', lastHash: 'old-hash' });
  });

  it('defaults to the existing 365-day retention setting', async () => {
    const { manager, service } = harness();
    await service.log(context());
    const row = manager.save.mock.calls[0][0] as AdminAuditLog;
    expect(row.retentionUntil.getTime() - row.timestamp.getTime())
      .toBe(365 * 86400000);
  });

  it.each([0, 1.5, 3651, NaN, Infinity, 'invalid'])(
    'refuses unsafe retention configuration %p before an audit insert',
    async (retention) => {
      const { manager, service } = harness(retention);
      await expect(service.log(context())).rejects.toThrow('retention');
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing/invalid database clock without inventing a client timestamp', async () => {
    const { manager, service } = harness();
    manager.query.mockResolvedValue([{ timestamp: 'invalid' }]);
    await expect(service.log(context())).rejects.toThrow('clock');
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('stores replay attempts using the existing administrative audit schema', async () => {
    const { manager, service } = harness();
    const { actorId, correlationId, targetId } = context();
    const chainContext = {
      chainId: 10,
      releaseId: 'release-1',
      deploymentBlock: '100',
      artifactChecksum: 'a'.repeat(64),
    };
    const result = await service.replayDeadLetter({
      actorId,
      correlationId,
      capability: 'dead_letter.replay',
      reason: 'Verify the original operation',
      messageId: targetId,
      originalPayloadHash: 'b'.repeat(64),
      chainContext,
      dryRun: true,
      batchSize: 1,
    });

    expect(manager.save.mock.calls[0][0]).toMatchObject({
      eventId: result.auditEventId,
      actorId,
      actorType: 'user',
      action: 'dead_letter_replay',
      actionCategory: AdminActionCategory.SYSTEM_OPERATIONS,
      targetId,
      requestReference: correlationId,
      resultReference: expect.stringMatching(/^[0-9a-f-]{36}$/),
      chainContext,
      outcome: 'attempted',
    });
  });
});
