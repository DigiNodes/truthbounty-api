import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  AdminAuditService,
  AdminActionType,
  AdminActionCategory,
  AdminAuditLogInput,
} from '../src/audit/services/admin-audit.service';
import { AdminAuditLog } from '../src/audit/entities/admin-audit-log.entity';
import { AdminAuditHead } from '../src/audit/entities/admin-audit-head.entity';
import { PersistAdministrativeAudit1792200000000 } from '../src/migrations/1792200000000-PersistAdministrativeAudit';

const url = process.env.ADMIN_AUDIT_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'administrative audit PostgreSQL persistence',
  () => {
    let source: DataSource;
    let service: AdminAuditService;
    const schema = `audit_test_${randomUUID().replaceAll('-', '')}`;
    const input = (): AdminAuditLogInput => ({
      actorId: randomUUID(),
      actorType: 'user',
      action: AdminActionType.USER_UPDATE,
      actionCategory: AdminActionCategory.USER_MANAGEMENT,
      targetType: 'user',
      targetId: randomUUID(),
      capability: 'user.update',
      authoritySource: 'rbac',
      authorityReference: randomUUID(),
      requestReference: randomUUID(),
      correlationId: randomUUID(),
      outcome: 'success',
    });
    beforeAll(async () => {
      source = new DataSource({
        type: 'postgres',
        url,
        entities: [AdminAuditLog, AdminAuditHead],
        schema,
        extra: { options: `-c search_path=${schema}` },
        synchronize: false,
      });
      await source.initialize();
      await source.query(`CREATE SCHEMA "${schema}"`);
      const runner = source.createQueryRunner();
      try {
        const migration = new PersistAdministrativeAudit1792200000000();
        await migration.up(runner);
        await migration.down(runner);
        await migration.up(runner);
        await runner.query(
          'CREATE TABLE operation_probe (id uuid PRIMARY KEY)',
        );
      } finally {
        await runner.release();
      }
      service = new AdminAuditService(source, new ConfigService());
    }, 30000);
    afterAll(async () => {
      if (source?.isInitialized) {
        await source.query(`DROP SCHEMA "${schema}" CASCADE`);
        await source.destroy();
      }
    });
    it('commits the domain write and success together, with a durable attempt', async () => {
      const context = input();
      const result = await service.execute(context, async (tx) => {
        await tx.query('INSERT INTO operation_probe VALUES ($1)', [
          context.targetId,
        ]);
        return 'done';
      });
      expect(result.result).toBe('done');
      expect((await service.getByEventId(result.eventId))?.outcome).toBe(
        'success',
      );
      expect(
        (
          await service.query({ correlationId: context.correlationId })
        ).logs.map((r) => r.outcome),
      ).toEqual(['success', 'attempted']);
      expect(
        await source.query('SELECT * FROM operation_probe WHERE id=$1', [
          context.targetId,
        ]),
      ).toHaveLength(1);
    });
    it('rolls back domain changes and records rollback without storing error text', async () => {
      const context = input();
      await expect(
        service.execute(context, async (tx) => {
          await tx.query('INSERT INTO operation_probe VALUES ($1)', [
            context.targetId,
          ]);
          throw new Error('secret-token');
        }),
      ).rejects.toThrow('secret-token');
      expect(
        await source.query('SELECT * FROM operation_probe WHERE id=$1', [
          context.targetId,
        ]),
      ).toHaveLength(0);
      const records = await service.query({
        correlationId: context.correlationId,
      });
      expect(records.logs.map((r) => r.outcome)).toEqual([
        'rolled_back',
        'attempted',
      ]);
      expect(JSON.stringify(records)).not.toContain('secret-token');
    });
    it('serializes concurrent writers and permits duplicate correlation references', async () => {
      const context = input();
      const other = new AdminAuditService(source, new ConfigService());
      const ids = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? service : other).log(context),
        ),
      );
      expect(new Set(ids).size).toBe(12);
      expect(
        (await service.query({ correlationId: context.correlationId })).total,
      ).toBe(12);
      expect((await other.verifyIntegrity()).valid).toBe(true);
    });
    it('allowlists fields, persists retention and forbids mutations', async () => {
      const context = {
        ...input(),
        metadata: { token: 'secret-token' },
        reason: 'secret-token',
      };
      const id = await service.log(context);
      const record = await service.getByEventId(id);
      expect(JSON.stringify(record)).not.toContain('secret-token');
      expect(
        record!.retentionUntil.getTime() - record!.timestamp.getTime(),
      ).toBe(365 * 86400000);
      for (const sql of [
        'UPDATE admin_audit_logs SET outcome=\'failure\' WHERE "eventId"=$1',
        'DELETE FROM admin_audit_logs WHERE "eventId"=$1',
      ]) {
        await expect(source.query(sql, [id])).rejects.toThrow('append-only');
      }
      await expect(source.query('TRUNCATE admin_audit_logs')).rejects.toThrow(
        'append-only',
      );
      expect((await service.verifyIntegrity()).valid).toBe(true);
    });
    it('rolls back an audit batch and rejects nontransactional managers', async () => {
      const context = input();
      await expect(
        source.transaction(async (tx) => {
          await service.log(context, tx);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(
        (await service.query({ correlationId: context.correlationId })).total,
      ).toBe(0);
      await expect(service.log(context, source.manager)).rejects.toThrow(
        'active transaction',
      );
      await expect(
        service.logBatch([context, { ...context, actorId: 'invalid' }]),
      ).rejects.toThrow('UUID');
      expect((await service.verifyIntegrity()).valid).toBe(true);
    });
    it('rolls back the operation when its success audit insert fails', async () => {
      const context = input();
      await source.query(`CREATE FUNCTION reject_success() RETURNS trigger AS $$
      BEGIN IF NEW.outcome = 'success' THEN RAISE EXCEPTION 'audit unavailable'; END IF;
      RETURN NEW; END; $$ LANGUAGE plpgsql`);
      await source.query(`CREATE TRIGGER reject_success BEFORE INSERT ON admin_audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_success()`);
      try {
        await expect(
          service.execute(context, async (tx) => {
            await tx.query('INSERT INTO operation_probe VALUES ($1)', [
              context.targetId,
            ]);
          }),
        ).rejects.toThrow('audit unavailable');
        expect(
          await source.query('SELECT * FROM operation_probe WHERE id=$1', [
            context.targetId,
          ]),
        ).toHaveLength(0);
        expect(
          (
            await service.query({ correlationId: context.correlationId })
          ).logs.map((r) => r.outcome),
        ).toEqual(['rolled_back', 'attempted']);
      } finally {
        await source.query('DROP TRIGGER reject_success ON admin_audit_logs');
        await source.query('DROP FUNCTION reject_success()');
      }
    });
    it('binds chain release evidence and detects tampering against its persisted head', async () => {
      const id = await service.log({
        ...input(),
        authoritySource: 'chain',
        chainContext: {
          chainId: 10,
          releaseId: randomUUID(),
          deploymentBlock: '123456',
          artifactChecksum: '0x' + 'ab'.repeat(32),
        },
      });
      expect(
        (
          await new AdminAuditService(
            source,
            new ConfigService(),
          ).verifyIntegrity()
        ).valid,
      ).toBe(true);
      await source.query(
        'ALTER TABLE admin_audit_logs DISABLE TRIGGER admin_audit_immutable',
      );
      try {
        await source.query(
          'UPDATE admin_audit_logs SET capability=$1 WHERE "eventId"=$2',
          ['tampered', id],
        );
        expect((await service.verifyIntegrity()).valid).toBe(false);
        await source.query(
          'UPDATE admin_audit_logs SET capability=$1 WHERE "eventId"=$2',
          ['user.update', id],
        );
      } finally {
        await source.query(
          'ALTER TABLE admin_audit_logs ENABLE TRIGGER admin_audit_immutable',
        );
      }
      expect((await service.verifyIntegrity()).valid).toBe(true);
    });
    it('records uncertainty when COMMIT succeeds but its acknowledgement is lost', async () => {
      const context = input();
      await expect(
        service.execute(context, async (tx) => {
          await tx.query('INSERT INTO operation_probe VALUES ($1)', [
            context.targetId,
          ]);
          const runner = tx.queryRunner!;
          const commit = runner.commitTransaction.bind(runner);
          jest
            .spyOn(runner, 'commitTransaction')
            .mockImplementationOnce(async () => {
              await commit();
              throw new Error('lost acknowledgement');
            });
        }),
      ).rejects.toThrow('lost acknowledgement');
      expect(
        (
          await service.query({ correlationId: context.correlationId })
        ).logs.map((r) => r.outcome),
      ).toEqual(['unknown', 'success', 'attempted']);
      expect(
        await source.query('SELECT * FROM operation_probe WHERE id=$1', [
          context.targetId,
        ]),
      ).toHaveLength(1);
    });
    it('rejects malformed chain authority and pagination', async () => {
      await expect(
        service.log({ ...input(), authoritySource: 'chain' }),
      ).rejects.toThrow('release context');
      await expect(service.query({ limit: 101 })).rejects.toThrow('pagination');
    });
    it('fails closed before executing work when persistence is unavailable', async () => {
      const offline = new DataSource({ type: 'postgres', url });
      const work = jest.fn();
      await expect(
        new AdminAuditService(offline, new ConfigService()).execute(
          input(),
          work,
        ),
      ).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
    });
  },
);
