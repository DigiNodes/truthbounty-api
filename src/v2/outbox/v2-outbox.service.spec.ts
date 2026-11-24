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

    it('rejects aggregateId exceeding 128 characters', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          aggregateId: 'b'.repeat(129),
        }),
      ).rejects.toThrow('aggregateId exceeds 128 characters');
    });

    it('rejects aggregateType with invalid characters (spaces, injection)', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          aggregateType: 'claim; DROP TABLE',
        }),
      ).rejects.toThrow('aggregateType contains invalid characters');
    });

    it('rejects aggregateId with invalid characters (spaces)', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          aggregateId: 'claim id with spaces',
        }),
      ).rejects.toThrow('aggregateId contains invalid characters');
    });

    it('rejects eventType that does not follow dotted namespace format', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          eventType: 'singleword',
        }),
      ).rejects.toThrow('eventType format is invalid');
    });

    it('rejects maxRetries < 1 or non-integer', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, { ...base, maxRetries: 0 }),
      ).rejects.toThrow('maxRetries must be an integer between 1 and 100');

      await expect(
        service.publishWithManager(manager, { ...base, maxRetries: 3.5 }),
      ).rejects.toThrow('maxRetries must be an integer between 1 and 100');

      await expect(
        service.publishWithManager(manager, { ...base, maxRetries: 101 }),
      ).rejects.toThrow('maxRetries must be an integer between 1 and 100');
    });

    it('rejects a non-Date or NaN scheduledAt', async () => {
      const manager = makeMockManager() as any;
      await expect(
        service.publishWithManager(manager, {
          ...base,
          scheduledAt: 'not-a-date' as any,
        }),
      ).rejects.toThrow('scheduledAt must be a valid Date');

      await expect(
        service.publishWithManager(manager, {
          ...base,
          scheduledAt: new Date('invalid'),
        }),
      ).rejects.toThrow('scheduledAt must be a valid Date');
    });

    it('rejects scheduledAt with extreme clock skew', async () => {
      const manager = makeMockManager() as any;
      const wayPast = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago
      await expect(
        service.publishWithManager(manager, {
          ...base,
          scheduledAt: wayPast,
        }),
      ).rejects.toThrow('scheduledAt cannot be more than 30 days in the past');

      const wayFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000); // 400 days in future
      await expect(
        service.publishWithManager(manager, {
          ...base,
          scheduledAt: wayFuture,
        }),
      ).rejects.toThrow('scheduledAt cannot be more than 1 year in the future');
    });

    it('validates chainProvenance when present and fails closed on invalid fields', async () => {
      const manager = makeMockManager() as any;

      // Invalid chainId
      await expect(
        service.publishWithManager(manager, {
          ...base,
          payload: {
            chainProvenance: {
              chainId: 0,
              releaseId: 'v2.0.0-sepolia',
              deploymentBlock: '100',
              artifactChecksum: 'a'.repeat(64),
            },
          },
        }),
      ).rejects.toThrow('chainId must be a positive integer');

      // Invalid releaseId
      await expect(
        service.publishWithManager(manager, {
          ...base,
          payload: {
            chainProvenance: {
              chainId: 11155420,
              releaseId: '',
              deploymentBlock: '100',
              artifactChecksum: 'a'.repeat(64),
            },
          },
        }),
      ).rejects.toThrow('releaseId must be a valid non-empty release string');

      // Invalid deploymentBlock
      await expect(
        service.publishWithManager(manager, {
          ...base,
          payload: {
            chainProvenance: {
              chainId: 11155420,
              releaseId: 'v2.0.0-sepolia',
              deploymentBlock: 'invalid-block',
              artifactChecksum: 'a'.repeat(64),
            },
          },
        }),
      ).rejects.toThrow('deploymentBlock must be a non-negative block number');

      // Invalid artifactChecksum
      await expect(
        service.publishWithManager(manager, {
          ...base,
          payload: {
            chainProvenance: {
              chainId: 11155420,
              releaseId: 'v2.0.0-sepolia',
              deploymentBlock: '100',
              artifactChecksum: 'not-64-hex',
            },
          },
        }),
      ).rejects.toThrow('artifactChecksum must be a 64-character lowercase hex SHA-256 hash');
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
      const k1 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        channel: 'email',
        recipientIds: ['u-a', 'u-b'],
      });
      const k2 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        channel: 'email',
        recipientIds: ['u-b', 'u-a'], // reversed order
      });
      expect(k1).toBe(k2);
    });

    it('binds chainProvenance into the idempotency key', () => {
      const basePayload = { channel: 'in_app' };
      const cp1 = {
        chainId: 11155420,
        releaseId: 'v2.0.0-sepolia',
        deploymentBlock: '100',
        artifactChecksum: 'a'.repeat(64),
      };
      const cp2 = {
        chainId: 10, // OP Mainnet
        releaseId: 'v2.0.0-sepolia',
        deploymentBlock: '100',
        artifactChecksum: 'a'.repeat(64),
      };

      const kNoChain = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', basePayload);
      const kChain1 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        ...basePayload,
        chainProvenance: cp1,
      });
      const kChain2 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {
        ...basePayload,
        chainProvenance: cp2,
      });

      expect(kNoChain).not.toBe(kChain1);
      expect(kChain1).not.toBe(kChain2);
    });

    it('is sensitive to eventType changes', () => {
      const k1 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {});
      const k2 = service.buildIdempotencyKey('webhook.fire', 'claim', 'c-1', {});
      expect(k1).not.toBe(k2);
    });

    it('is sensitive to aggregateId changes', () => {
      const k1 = service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {});
      const k2 = service.buildIdempotencyKey('notification.send', 'claim', 'c-2', {});
      expect(k1).not.toBe(k2);
    });

    it('handles empty payload gracefully', () => {
      expect(() =>
        service.buildIdempotencyKey('notification.send', 'claim', 'c-1', {}),
      ).not.toThrow();
    });
  });

  // ── Observability & Delivery Audit ─────────────────────────────────────────

  describe('observability & delivery history audit', () => {
    it('delegates pending count to DataSource repository', async () => {
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

    it('getDeliveryHistory returns records ordered chronologically', async () => {
      const mockHistory = [
        { id: '1', createdAt: new Date('2026-01-01') },
        { id: '2', createdAt: new Date('2026-01-02') },
      ];
      const repoMock = { find: jest.fn().mockResolvedValue(mockHistory) };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      const res = await service.getDeliveryHistory('claim', 'claim-123');
      expect(res).toEqual(mockHistory);
      expect(repoMock.find).toHaveBeenCalledWith({
        where: { aggregateType: 'claim', aggregateId: 'claim-123' },
        order: { createdAt: 'ASC' },
      });
    });

    it('getMessageByIdempotencyKey queries by unique idempotency key', async () => {
      const mockMsg = { id: 'msg-1', idempotencyKey: 'key-123' };
      const repoMock = { findOneBy: jest.fn().mockResolvedValue(mockMsg) };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      const res = await service.getMessageByIdempotencyKey('key-123');
      expect(res).toEqual(mockMsg);
      expect(repoMock.findOneBy).toHaveBeenCalledWith({ idempotencyKey: 'key-123' });
    });

    it('getDeliveryAudit returns paginated items and total', async () => {
      const mockItems = [{ id: '1' }, { id: '2' }];
      const repoMock = { findAndCount: jest.fn().mockResolvedValue([mockItems, 2]) };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      const res = await service.getDeliveryAudit({
        status: V2OutboxStatus.DEAD_LETTER,
        limit: 10,
        offset: 0,
      });
      expect(res.total).toBe(2);
      expect(res.items).toHaveLength(2);
      expect(repoMock.findAndCount).toHaveBeenCalledWith({
        where: { status: V2OutboxStatus.DEAD_LETTER },
        order: { createdAt: 'DESC' },
        take: 10,
        skip: 0,
      });
    });

    it('replayDeadLetter resets a DEAD_LETTER message to PENDING', async () => {
      const deadMsg = {
        id: 'msg-dead',
        status: V2OutboxStatus.DEAD_LETTER,
        retryCount: 5,
        lastError: 'failed',
      };
      const repoMock = {
        findOneBy: jest.fn().mockResolvedValue(deadMsg),
        save: jest.fn().mockImplementation((m) => Promise.resolve(m)),
      };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      const replayed = await service.replayDeadLetter('msg-dead');
      expect(replayed.status).toBe(V2OutboxStatus.PENDING);
      expect(replayed.retryCount).toBe(0);
      expect(replayed.lastError).toBeNull();
      expect(repoMock.save).toHaveBeenCalled();
    });

    it('replayDeadLetter throws fail-closed if message is not in DEAD_LETTER status', async () => {
      const pendingMsg = { id: 'msg-pend', status: V2OutboxStatus.PENDING };
      const repoMock = { findOneBy: jest.fn().mockResolvedValue(pendingMsg) };
      mockDataSource.getRepository.mockReturnValue(repoMock);

      await expect(service.replayDeadLetter('msg-pend')).rejects.toThrow(
        'cannot replay message msg-pend with status PENDING',
      );
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
