import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDurableOperationalControls1793200000000 implements MigrationInterface {
  name = 'AddDurableOperationalControls1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "operational_controls" (
      "id" varchar(64) NOT NULL,
      "maintenanceActive" boolean NOT NULL DEFAULT false,
      "maintenanceReason" varchar,
      "maintenanceStartedAt" timestamptz,
      "maintenanceScheduledEnd" timestamptz,
      "schedules" jsonb NOT NULL DEFAULT '[]',
      "emergencies" jsonb NOT NULL DEFAULT '{}',
      "services" jsonb NOT NULL DEFAULT '{}',
      "pendingCanonicalActions" jsonb NOT NULL DEFAULT '{}',
      "updatedBy" varchar,
      "version" integer NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "pk_operational_controls" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "operational_control_events" (
      "id" uuid NOT NULL,
      "controlId" varchar(64) NOT NULL,
      "operation" varchar(64) NOT NULL,
      "actorId" varchar(64) NOT NULL,
      "reason" varchar(255) NOT NULL,
      "beforeState" jsonb NOT NULL,
      "afterState" jsonb NOT NULL,
      "auditReference" varchar(255) NOT NULL,
      "controlVersion" integer NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "pk_operational_control_events" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_operational_control_events_control" ON "operational_control_events" ("controlId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_operational_controls_updated_by" ON "operational_controls" ("updatedBy")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "operational_control_events"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "operational_controls"`);
  }
}
