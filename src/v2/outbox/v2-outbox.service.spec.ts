import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { V2OutboxService } from './v2-outbox.service';
import { V2OutboxMessage, V2OutboxStatus } from './entities/v2-outbox-message.entity';

describe('V2OutboxService', () => {
  let service: V2OutboxService;
  let mockDataSource: { getRepository: jest.Mock };

  // A minimal EntityManager mock used as the "active transaction" argument.
  function makeMockManager(saveResult: Partial<V2OutboxMessage> = { id: 'msg-uuid-1' }) {
    return {
      getRepository: jest.fn().mockReturnValue({
        create: jest.fn().mockImplementation((data) => ({ ...data })),
        save: jest.fn().mockResolvedValue({ id: 'msg-uuid-1', ...saveResult }),
        countBy: jest.fn().mockResolvedValue(0),
      }),
    };
  }

  beforeEach(async () => {
    mockDataSource = {
      getRepository: jest.fn().mockReturnValue({
        countBy: jest.fn().mockResolvedValue(0),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        V2OutboxService,
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<V2OutboxService>(V2OutboxService);
  });

  // ── publishWithManager ────────────────────────────────────────────────────

  describe('publishWithManager', () => {
    it('writes a PENDING row using the caller-supplied manager (not the DataSource)', async () => {
      const manager = makeMockManager() as any;

      const result = await service.publishWithManager(manager, {
        aggregateType: 'claim',
        aggregateId: 'claim-abc',
        eventType: 'notification.send',
        payload: { channel: 'in_app', recipientIds: ['user-1'] },
      });

      expect(result.id).toBe('msg-uuid-1');
      expect(result.idempotencyKey).toHaveLength(64); // sha256 hex

      // Must use the passed-in manager, never the global DataSource.
      expect(manager.getRepository).toHaveBeenCalledWith(V2OutboxMessage);
      expect(mockDataSource.getRepository).not.toHaveBeenCalled();
    });

    it('persists status=PENDING and retryCount=0', async () => {
      const manager = makeMockManager() as any;
      const repo = manager.getRepository(V2OutboxMessage);

      await service.publishWithManager(manager, {
        aggregateType: 'evidence',
        aggregateId: 'ev-1',
        eventType: 'webhook.fire',
        payload: {},
      });

      const createCall = repo.create.mock.calls[0][0];
      expect(createCall.status).toBe(V2OutboxStatus.PENDING);
      expect(createCall.retryCount).toBe(0);
      expect(createCall.lastError).toBeNull();
      expect(createCall.jobId).toBeNull();
    });

    it('uses the custom maxRetries when provided', async () => {
      const manager = makeMockManager() as any;
      const repo = manager.getRepository(V2OutboxMessage);

      await service.publishWithManager(manager, {
        aggregateType: 'claim',
        aggregateId: 'claim-1',
        eventType: 'notification.send',
        payload: {},
        maxRetries: 3,
      });

      const createCall = repo.create.mock.calls[0][0];
      expect(createCall.maxRetries).toBe(3);
    });

    it('uses scheduledAt when provided', async () => {
      const manager = makeMockManager() as any;
      const repo = manager.getRepository(V2OutboxMessage);
      const future = new Date(Date.now() + 60_000);

      await service.publishWithManager(manager, {
        aggregateType: 'claim',
        aggregateId: 'claim-1',
        eventType: 'notification.send',
        payload: {},
        scheduledAt: future,
      });

      const createCall = repo.create.mock.calls[0][0];
      expect(createCall.scheduledAt).toBe(future);
    });

    it('does NOT call manager.getRepository if validation fails (fail-closed)', async () => {
      const manager = makeMockManager() as any;

      await expect(
        service.publishWithManager(manager, {
          aggregateType: '',
          aggregateId: 'ev-1',
          eventType: 'notification.send',
          payload: {},
        }),
      ).rejects.toThrow('aggregateType must not be empty');

      expect(manager.getRepository).not.toHaveBeenCalled();
    });
  });

  // ── Validation boundary conditions ────────────────────────────────────────

  describe('validation (fail-closed)', () => {
    const base = {
      aggregateType: 'claim',
      aggregateId: 'claim-1',
      eventType: 'notification.send',
      payload: {},
    };

    it('rejects empty aggregateId', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, { ...base, aggregateId: '   ' }),
      ).rejects.toThrow('aggregateId must not be empty');
    });

    it('rejects empty eventType', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, { ...base, eventType: '' }),
      ).rejects.toThrow('eventType must not be empty');
    });

    it('rejects aggregateType exceeding 128 characters', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          aggregateType: 'a'.repeat(129),
        }),
      ).rejects.toThrow('aggregateType exceeds 128 characters');
    });

    it('rejects maxRetries < 1', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, { ...base, maxRetries: 0 }),
      ).rejects.toThrow('maxRetries must be >= 1');
    });

    it('rejects a non-Date scheduledAt', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          scheduledAt: 'not-a-date' as any,
        }),
      ).rejects.toThrow('scheduledAt must be a Date');
    });
  });

  // ── buildIdempotencyKey ───────────────────────────────────────────────────

  describe('buildIdempotencyKey', () => {
    it('produces a 64-character sha256 hex string', () => {
      const key = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        channel: 'in_app',
        recipientIds: ['u-1'],
      });
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic — same inputs produce the same key', () => {
      const k1 = service.buildIdempotencyKey('evt', 'claim', 'c-1', {
        channel: 'email',
        recipientIds: ['u-a', 'u-b'],
      });
      const k2 = service.buildIdempotencyKey('evt', 'claim', 'c-1', {
        channel: 'email',
        recipientIds: ['u-b', 'u-a'], // reversed order
      });
      expect(k1).toBe(k2);
    });

    it('is sensitive to eventType changes', () => {
      const k1 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {});
      const k2 = service.buildIdempotencyKey('webhook.fire', 'claim', 'c-1', {});
      expect(k1).not.toBe(k2);
    });

    it('is sensitive to aggregateId changes', () => {
      const k1 = service.buildIdempotencyKey('evt', 'claim', 'c-1', {});
      const k2 = service.buildIdempotencyKey('evt', 'claim', 'c-2', {});
      expect(k1).not.toBe(k2);
    });

    it('handles empty payload gracefully', () => {
      expect(() =>
        service.buildIdempotencyKey('evt', 'claim', 'c-1', {}),
      ).not.toThrow();
    });
  });

  // ── Observability ─────────────────────────────────────────────────────────

  describe('getPendingCount / getDeadLetterCount', () => {
    it('delegates to the DataSource repository', async () => {
      const repoMock = { countBy: jest.fn().mockResolvedValue(7) };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      const count = await service.getPendingCount();
      expect(count).toBe(7);
      expect(repoMock.countBy).toHaveBeenCalledWith({
        status: V2OutboxStatus.PENDING,
      });
    });

    it('returns dead-letter count', async () => {
      const repoMock = { countBy: jest.fn().mockResolvedValue(3) };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      const count = await service.getDeadLetterCount();
      expect(count).toBe(3);
      expect(repoMock.countBy).toHaveBeenCalledWith({
        status: V2OutboxStatus.DEAD_LETTER,
      });
    });
  });

  // ── Protocol-authority regression ────────────────────────────────────────

  describe('protocol authority regression', () => {
    it('publishWithManager only touches the v2_outbox_messages table via the passed manager', async () => {
      // The service must not use the DataSource directly to write domain state.
      const manager = makeMockManager() as any;

      await service.publishWithManager(manager, {
        aggregateType: 'verification_round',
        aggregateId: 'vr-1',
        eventType: 'notification.send',
        payload: { channel: 'in_app', recipientIds: ['user-99'] },
      });

      // DataSource was not used for writing — only the caller's manager was.
      const writeCallsOnDataSource = (mockDataSource.getRepository as jest.Mock).mock.calls.filter(
        (c) => c[0] !== V2OutboxMessage,
      );
      expect(writeCallsOnDataSource).toHaveLength(0);
    });

    it('does not produce a row for an invalid call', async () => {
      const manager = makeMockManager() as any;
      const repo = manager.getRepository(V2OutboxMessage);

      try {
        await service.publishWithManager(manager, {
          aggregateType: '',
          aggregateId: 'ev-1',
          eventType: 'notification.send',
          payload: {},
        });
      } catch {
        // expected
      }

      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
