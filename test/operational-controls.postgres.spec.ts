import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OperationalControl } from '../src/admin/entities/operational-control.entity';
import { OperationalControlEvent } from '../src/admin/entities/operational-control-event.entity';
import { AddDurableOperationalControls1793200000000 } from '../src/migrations/1793200000000-AddDurableOperationalControls';
import {
  getLockedControl,
  recordControlEvent,
} from '../src/admin/protocol/operational-control-store';

const url =
  process.env.OPERATIONAL_CONTROLS_TEST_DATABASE_URL ??
  process.env.ADMIN_AUDIT_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'durable operational controls PostgreSQL persistence',
  () => {
    let source: DataSource;
    const schema = `operational_controls_test_${randomUUID().replaceAll('-', '')}`;

    beforeAll(async () => {
      source = new DataSource({
        type: 'postgres',
        url,
        entities: [OperationalControl, OperationalControlEvent],
        schema,
        extra: { options: `-c search_path=${schema}` },
        synchronize: false,
      });
      await source.initialize();
      await source.query(`CREATE SCHEMA "${schema}"`);
      const runner = source.createQueryRunner();
      try {
        await new AddDurableOperationalControls1793200000000().up(runner);
      } finally {
        await runner.release();
      }
      await source.query('DELETE FROM "operational_controls"');
    }, 30000);

    afterAll(async () => {
      if (source?.isInitialized) {
        await source.query(`DROP SCHEMA "${schema}" CASCADE`);
        await source.destroy();
      }
    });

    it('persists both concurrent first-use mutations from an empty table', async () => {
      await Promise.all([
        source.transaction(async (manager) => {
          const control = await getLockedControl(manager);
          control.services = {
            ...((control.services ?? {}) as Record<string, boolean>),
            notifications: false,
          };
          await manager.getRepository(OperationalControl).save(control);
        }),
        source.transaction(async (manager) => {
          const control = await getLockedControl(manager);
          control.services = {
            ...((control.services ?? {}) as Record<string, boolean>),
            integrations: false,
          };
          await manager.getRepository(OperationalControl).save(control);
        }),
      ]);

      const saved = await source
        .getRepository(OperationalControl)
        .findOneBy({ id: 'system' });
      expect(saved?.services).toMatchObject({
        notifications: false,
        integrations: false,
      });
    });

    it('rolls back the control change when its event insert fails', async () => {
      await source.query(`CREATE FUNCTION reject_control_event() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'event store unavailable'; END; $$ LANGUAGE plpgsql`);
      await source.query(`CREATE TRIGGER reject_control_event BEFORE INSERT ON "operational_control_events"
      FOR EACH ROW EXECUTE FUNCTION reject_control_event()`);
      try {
        await expect(
          source.transaction(async (manager) => {
            const control = await getLockedControl(manager);
            control.maintenanceActive = true;
            await manager.getRepository(OperationalControl).save(control);
            await recordControlEvent(
              manager,
              control,
              'maintenance_enable',
              'admin-1',
              'rollback test',
              { maintenanceActive: false },
              { maintenanceActive: true },
            );
          }),
        ).rejects.toThrow('event store unavailable');

        const saved = await source
          .getRepository(OperationalControl)
          .findOneBy({ id: 'system' });
        expect(saved?.maintenanceActive).toBe(false);
        expect(
          await source.getRepository(OperationalControlEvent).count(),
        ).toBe(0);
      } finally {
        await source.query(
          'DROP TRIGGER reject_control_event ON "operational_control_events"',
        );
        await source.query('DROP FUNCTION reject_control_event()');
      }
    });
  },
);
