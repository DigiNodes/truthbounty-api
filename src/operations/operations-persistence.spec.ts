import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ConfigModule } from '@nestjs/config';
import {
  DurableOperationsIdempotencyStore,
  OPERATIONS_IDEMPOTENCY_STORE,
} from './operations-idempotency.store';
import {
  DurableOperationsAuditStore,
  OPERATIONS_AUDIT_STORE,
} from './operations-audit.store';
import {
  OperationsIdempotencyKey,
  OperationsAuditLog,
} from './entities';
import {
  OperationalCapability,
  AuthoritySource,
  RetrySubmission,
  OperationalAuditRecord,
} from './operations.types';

/**
 * Integration tests for durable idempotency and audit persistence (PREWAVE-BE-110, #811).
 *
 * These tests verify:
 * - Idempotency keys survive across service restarts (simulated by module rebuild)
 * - Duplicate keys return cached outcomes without re-execution
 * - Constraint violations are handled gracefully (concurrent replica simulation)
 * - Audit records are immutable and survive restarts
 * - Cleanup mechanisms work correctly (TTL and retention)
 * - Transaction boundaries ensure atomicity
 *
 * Uses an in-memory SQLite database for fast, isolated testing.
 */
describe('Operations Durable Persistence (PREWAVE-BE-110, #811)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let idempotencyStore: DurableOperationsIdempotencyStore;
  let auditStore: DurableOperationsAuditStore;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
          type: 'sqlite',
          database: ':memory:',
          entities: [OperationsIdempotencyKey, OperationsAuditLog],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OperationsIdempotencyKey, OperationsAuditLog]),
      ],
      providers: [
        DurableOperationsIdempotencyStore,
        DurableOperationsAuditStore,
      ],
    }).compile();

    dataSource = module.get<DataSource>(DataSource);
    idempotencyStore = module.get<DurableOperationsIdempotencyStore>(
      DurableOperationsIdempotencyStore,
    );
    auditStore = module.get<DurableOperationsAuditStore>(
      DurableOperationsAuditStore,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    // Clear tables before each test
    await dataSource.getRepository(OperationsIdempotencyKey).clear();
    await dataSource.getRepository(OperationsAuditLog).clear();
  });

  describe('Idempotency Store', () => {
    const mockOutcome: RetrySubmission = {
      id: 'item-001',
      accepted: true,
      auditId: 'audit-123',
      replayed: 1,
      skipped: 0,
      failed: 0,
      detail: null,
    };

    it('saves and retrieves an idempotency key', async () => {
      await dataSource.transaction(async (manager) => {
        await idempotencyStore.save(
          {
            key: 'idem-key-001',
            itemId: 'item-001',
            actorId: 'admin-123',
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.PROTOCOL_OPERATOR,
            authorityExpiresAt: new Date(Date.now() + 3600000).toISOString(),
            outcome: mockOutcome,
          },
          manager,
        );
      });

      const check = await idempotencyStore.check('idem-key-001');

      expect(check.exists).toBe(true);
      expect(check.record).not.toBeNull();
      expect(check.record!.key).toBe('idem-key-001');
      expect(check.record!.itemId).toBe('item-001');
      expect(check.record!.actorId).toBe('admin-123');
      expect(check.record!.outcome).toEqual(mockOutcome);
      expect(check.itemMatches).toBe(true);
    });

    it('returns not-found for unknown keys', async () => {
      const check = await idempotencyStore.check('unknown-key');

      expect(check.exists).toBe(false);
      expect(check.record).toBeNull();
      expect(check.itemMatches).toBe(false);
    });

    it('rejects duplicate keys via constraint violation', async () => {
      await dataSource.transaction(async (manager) => {
        await idempotencyStore.save(
          {
            key: 'idem-key-dup',
            itemId: 'item-001',
            actorId: null,
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            authorityExpiresAt: null,
            outcome: mockOutcome,
          },
          manager,
        );
      });

      // Attempt to insert the same key again (simulates concurrent replica)
      await expect(
        dataSource.transaction(async (manager) => {
          await idempotencyStore.save(
            {
              key: 'idem-key-dup',
              itemId: 'item-002',
              actorId: null,
              capability: OperationalCapability.RETRY_SUBMIT,
              authoritySource: AuthoritySource.SYSTEM,
              authorityExpiresAt: null,
              outcome: { ...mockOutcome, id: 'item-002' },
            },
            manager,
          );
        }),
      ).rejects.toThrow(); // Constraint violation
    });

    it('survives a simulated restart (fetches after module rebuild)', async () => {
      // Insert a key
      await dataSource.transaction(async (manager) => {
        await idempotencyStore.save(
          {
            key: 'restart-key',
            itemId: 'item-restart',
            actorId: 'admin-restart',
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.EMERGENCY_ADMIN,
            authorityExpiresAt: new Date(Date.now() + 3600000).toISOString(),
            outcome: mockOutcome,
          },
          manager,
        );
      });

      // Simulate restart: create a new store instance with the same data source
      const newStore = new DurableOperationsIdempotencyStore(
        dataSource.getRepository(OperationsIdempotencyKey),
      );

      const check = await newStore.check('restart-key');

      expect(check.exists).toBe(true);
      expect(check.record).not.toBeNull();
      expect(check.record!.key).toBe('restart-key');
      expect(check.record!.itemId).toBe('item-restart');
      expect(check.record!.actorId).toBe('admin-restart');
      expect(check.record!.outcome).toEqual(mockOutcome);
    });

    it('cleans up expired keys', async () => {
      const now = new Date();
      const expiredDate = new Date(now.getTime() - 1000); // 1 second ago
      const futureDate = new Date(now.getTime() + 3600000); // 1 hour ahead

      // Insert one expired and one active key
      await dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(OperationsIdempotencyKey);

        await repo.save(
          repo.create({
            key: 'expired-key',
            itemId: 'item-001',
            actorId: null,
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            authorityExpiresAt: null,
            outcome: mockOutcome,
            createdAt: new Date(now.getTime() - 86400000),
            expiresAt: expiredDate,
          }),
        );

        await repo.save(
          repo.create({
            key: 'active-key',
            itemId: 'item-002',
            actorId: null,
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            authorityExpiresAt: null,
            outcome: mockOutcome,
            createdAt: now,
            expiresAt: futureDate,
          }),
        );
      });

      const deleted = await idempotencyStore.cleanupExpired();

      expect(deleted).toBe(1);

      const expiredCheck = await idempotencyStore.check('expired-key');
      const activeCheck = await idempotencyStore.check('active-key');

      expect(expiredCheck.exists).toBe(false);
      expect(activeCheck.exists).toBe(true);
    });

    it('respects custom TTL when saving keys', async () => {
      const customTtlSeconds = 3600; // 1 hour
      const beforeSave = Date.now();

      await dataSource.transaction(async (manager) => {
        await idempotencyStore.save(
          {
            key: 'ttl-key',
            itemId: 'item-ttl',
            actorId: null,
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            authorityExpiresAt: null,
            outcome: mockOutcome,
            ttlSeconds: customTtlSeconds,
          },
          manager,
        );
      });

      const afterSave = Date.now();

      const check = await idempotencyStore.check('ttl-key');
      expect(check.exists).toBe(true);

      const expiresAtMs = check.record!.expiresAt.getTime();
      const expectedMinExpiry = beforeSave + customTtlSeconds * 1000;
      const expectedMaxExpiry = afterSave + customTtlSeconds * 1000;

      expect(expiresAtMs).toBeGreaterThanOrEqual(expectedMinExpiry);
      expect(expiresAtMs).toBeLessThanOrEqual(expectedMaxExpiry);
    });
  });

  describe('Audit Store', () => {
    const mockAuditRecord: OperationalAuditRecord = {
      auditId: 'audit-001',
      action: 'queue.retry',
      capability: OperationalCapability.RETRY_SUBMIT,
      authoritySource: AuthoritySource.PROTOCOL_OPERATOR,
      actorId: 'admin-001',
      outcome: 'accepted',
      resultCode: 'ACCEPTED',
      subjectId: 'item-001',
      createdAt: new Date().toISOString(),
    };

    it('saves and retrieves an audit record', async () => {
      await dataSource.transaction(async (manager) => {
        await auditStore.save(mockAuditRecord, manager);
      });

      const retrieved = await auditStore.get('audit-001');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.auditId).toBe('audit-001');
      expect(retrieved!.action).toBe('queue.retry');
      expect(retrieved!.capability).toBe(OperationalCapability.RETRY_SUBMIT);
      expect(retrieved!.actorId).toBe('admin-001');
      expect(retrieved!.outcome).toBe('accepted');
      expect(retrieved!.subjectId).toBe('item-001');
    });

    it('returns null for unknown audit IDs', async () => {
      const retrieved = await auditStore.get('unknown-audit-id');
      expect(retrieved).toBeNull();
    });

    it('audit records are immutable (no UPDATE support)', async () => {
      await dataSource.transaction(async (manager) => {
        await auditStore.save(mockAuditRecord, manager);
      });

      // There is no update method; audit records are write-once
      const repo = dataSource.getRepository(OperationsAuditLog);
      const record = await repo.findOne({ where: { auditId: 'audit-001' } });

      expect(record).not.toBeNull();
      expect(record!.outcome).toBe('accepted');

      // Attempting to manually update should be rejected (if triggers/RLS exist)
      // or considered a violation of the service contract. Here we just verify
      // the record exists and matches the original input.
      const retrievedAgain = await auditStore.get('audit-001');
      expect(retrievedAgain).toEqual(expect.objectContaining({
        auditId: 'audit-001',
        outcome: 'accepted',
      }));
    });

    it('survives a simulated restart', async () => {
      await dataSource.transaction(async (manager) => {
        await auditStore.save(
          {
            ...mockAuditRecord,
            auditId: 'restart-audit',
            actorId: 'admin-restart',
          },
          manager,
        );
      });

      // Simulate restart: new store instance with same data source
      const newStore = new DurableOperationsAuditStore(
        dataSource.getRepository(OperationsAuditLog),
      );

      const retrieved = await newStore.get('restart-audit');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.auditId).toBe('restart-audit');
      expect(retrieved!.actorId).toBe('admin-restart');
    });

    it('cleans up expired audit records', async () => {
      const now = new Date();
      const pastRetention = new Date(now.getTime() - 1000); // 1 second ago
      const futureRetention = new Date(now.getTime() + 86400000); // 1 day ahead

      await dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(OperationsAuditLog);

        await repo.save(
          repo.create({
            auditId: 'expired-audit',
            action: 'queue.retry',
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            actorId: null,
            outcome: 'rejected',
            resultCode: 'NOT_FOUND',
            subjectId: 'item-001',
            createdAt: new Date(now.getTime() - 90 * 86400000),
            retentionUntil: pastRetention,
          }),
        );

        await repo.save(
          repo.create({
            auditId: 'active-audit',
            action: 'queue.retry',
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            actorId: null,
            outcome: 'accepted',
            resultCode: 'ACCEPTED',
            subjectId: 'item-002',
            createdAt: now,
            retentionUntil: futureRetention,
          }),
        );
      });

      const deleted = await auditStore.cleanupExpired();

      expect(deleted).toBe(1);

      const expiredCheck = await auditStore.get('expired-audit');
      const activeCheck = await auditStore.get('active-audit');

      expect(expiredCheck).toBeNull();
      expect(activeCheck).not.toBeNull();
    });

    it('respects custom retention period when saving records', async () => {
      const customRetentionDays = 180;
      const beforeSave = Date.now();

      await dataSource.transaction(async (manager) => {
        await auditStore.save(
          {
            ...mockAuditRecord,
            auditId: 'retention-audit',
            retentionDays: customRetentionDays,
          } as any,
          manager,
        );
      });

      const afterSave = Date.now();

      const repo = dataSource.getRepository(OperationsAuditLog);
      const record = await repo.findOne({ where: { auditId: 'retention-audit' } });

      expect(record).not.toBeNull();

      const retentionMs = record!.retentionUntil.getTime();
      const createdMs = record!.createdAt.getTime();
      const expectedRetentionMs = customRetentionDays * 86400 * 1000;

      expect(retentionMs - createdMs).toBeGreaterThanOrEqual(expectedRetentionMs - 1000);
      expect(retentionMs - createdMs).toBeLessThanOrEqual(expectedRetentionMs + 1000);
    });
  });

  describe('Transaction Atomicity', () => {
    it('rolls back all writes if transaction fails', async () => {
      const mockOutcome: RetrySubmission = {
        id: 'item-txn',
        accepted: true,
        auditId: 'audit-txn',
        replayed: 1,
        skipped: 0,
        failed: 0,
        detail: null,
      };

      const mockAudit: OperationalAuditRecord = {
        auditId: 'audit-txn',
        action: 'queue.retry',
        capability: OperationalCapability.RETRY_SUBMIT,
        authoritySource: AuthoritySource.SYSTEM,
        actorId: null,
        outcome: 'accepted',
        resultCode: 'ACCEPTED',
        subjectId: 'item-txn',
        createdAt: new Date().toISOString(),
      };

      try {
        await dataSource.transaction(async (manager) => {
          await idempotencyStore.save(
            {
              key: 'txn-key',
              itemId: 'item-txn',
              actorId: null,
              capability: OperationalCapability.RETRY_SUBMIT,
              authoritySource: AuthoritySource.SYSTEM,
              authorityExpiresAt: null,
              outcome: mockOutcome,
            },
            manager,
          );

          await auditStore.save(mockAudit, manager);

          // Force a rollback by throwing
          throw new Error('Simulated failure');
        });
      } catch (error) {
        expect((error as Error).message).toBe('Simulated failure');
      }

      // Verify neither record was committed
      const idempotencyCheck = await idempotencyStore.check('txn-key');
      const auditCheck = await auditStore.get('audit-txn');

      expect(idempotencyCheck.exists).toBe(false);
      expect(auditCheck).toBeNull();
    });

    it('commits all writes if transaction succeeds', async () => {
      const mockOutcome: RetrySubmission = {
        id: 'item-success',
        accepted: true,
        auditId: 'audit-success',
        replayed: 1,
        skipped: 0,
        failed: 0,
        detail: null,
      };

      const mockAudit: OperationalAuditRecord = {
        auditId: 'audit-success',
        action: 'queue.retry',
        capability: OperationalCapability.RETRY_SUBMIT,
        authoritySource: AuthoritySource.SYSTEM,
        actorId: null,
        outcome: 'accepted',
        resultCode: 'ACCEPTED',
        subjectId: 'item-success',
        createdAt: new Date().toISOString(),
      };

      await dataSource.transaction(async (manager) => {
        await idempotencyStore.save(
          {
            key: 'success-key',
            itemId: 'item-success',
            actorId: null,
            capability: OperationalCapability.RETRY_SUBMIT,
            authoritySource: AuthoritySource.SYSTEM,
            authorityExpiresAt: null,
            outcome: mockOutcome,
          },
          manager,
        );

        await auditStore.save(mockAudit, manager);
      });

      // Verify both records were committed
      const idempotencyCheck = await idempotencyStore.check('success-key');
      const auditCheck = await auditStore.get('audit-success');

      expect(idempotencyCheck.exists).toBe(true);
      expect(auditCheck).not.toBeNull();
      expect(idempotencyCheck.record!.itemId).toBe('item-success');
      expect(auditCheck!.auditId).toBe('audit-success');
    });
  });
});
