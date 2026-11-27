import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFeatureFlagVersioning1792200000100 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Feature flag version history requires PostgreSQL');
    }

    await runner.query(`CREATE TABLE "feature_flag_versions" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "flagId" uuid NOT NULL,
      "key" varchar NOT NULL,
      "version" integer NOT NULL,
      "type" varchar NOT NULL,
      "enabled" boolean NOT NULL DEFAULT false,
      "rolloutPercentage" double precision NOT NULL DEFAULT 0,
      "rules" jsonb NULL,
      "environment" varchar NOT NULL,
      "description" text NULL,
      "isPermanent" boolean NOT NULL DEFAULT false,
      "metadata" jsonb NULL,
      "expiresAt" timestamp NULL,
      "contentHash" varchar NOT NULL,
      "previousHash" varchar NULL,
      "sourceVersion" integer NULL,
      "validationStatus" varchar NOT NULL DEFAULT 'valid',
      "actorId" varchar NULL,
      "changeReason" text NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "PK_feature_flag_versions" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_feature_flag_versions_version" CHECK ("version" > 0),
      CONSTRAINT "CHK_feature_flag_versions_source" CHECK ("sourceVersion" IS NULL OR "sourceVersion" > 0),
      CONSTRAINT "CHK_feature_flag_versions_validation" CHECK ("validationStatus" IN ('valid','invalid','revoked'))
    )`);
    await runner.query(
      `CREATE UNIQUE INDEX "UQ_feature_flag_versions_flag_version" ON "feature_flag_versions" ("flagId", "version")`,
    );
    await runner.query(
      `CREATE INDEX "IDX_feature_flag_versions_created" ON "feature_flag_versions" ("flagId", "createdAt")`,
    );

    await runner.query(`CREATE TABLE "feature_flag_audit_events" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "flagId" uuid NOT NULL,
      "key" varchar NOT NULL,
      "action" varchar NOT NULL,
      "actorId" varchar NULL,
      "sourceVersion" integer NULL,
      "fromVersion" integer NULL,
      "toVersion" integer NULL,
      "outcome" varchar NOT NULL DEFAULT 'applied',
      "reason" text NULL,
      "beforeState" jsonb NULL,
      "afterState" jsonb NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "PK_feature_flag_audit_events" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_feature_flag_audit_action" CHECK ("action" IN ('create','update','rollback','emergency_disable')),
      CONSTRAINT "CHK_feature_flag_audit_outcome" CHECK ("outcome" IN ('applied','rejected'))
    )`);
    await runner.query(
      `CREATE INDEX "IDX_feature_flag_audit_flag_time" ON "feature_flag_audit_events" ("flagId", "createdAt")`,
    );
    await runner.query(
      `CREATE INDEX "IDX_feature_flag_audit_action_outcome" ON "feature_flag_audit_events" ("action", "outcome")`,
    );
    await runner.query(
      `CREATE INDEX "IDX_feature_flag_audit_versions" ON "feature_flag_audit_events" ("flagId", "fromVersion", "toVersion")`,
    );

    await runner.query(`CREATE FUNCTION reject_feature_flag_version_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Feature flag version snapshots are append-only'; END;
    $$ LANGUAGE plpgsql`);
    await runner.query(`CREATE FUNCTION reject_feature_flag_audit_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Feature flag audit events are append-only'; END;
    $$ LANGUAGE plpgsql`);
    await runner.query(`CREATE TRIGGER feature_flag_version_immutable BEFORE UPDATE OR DELETE ON "feature_flag_versions"
      FOR EACH ROW EXECUTE FUNCTION reject_feature_flag_version_mutation()`);
    await runner.query(`CREATE TRIGGER feature_flag_version_no_truncate BEFORE TRUNCATE ON "feature_flag_versions"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_feature_flag_version_mutation()`);
    await runner.query(`CREATE TRIGGER feature_flag_audit_immutable BEFORE UPDATE OR DELETE ON "feature_flag_audit_events"
      FOR EACH ROW EXECUTE FUNCTION reject_feature_flag_audit_mutation()`);
    await runner.query(`CREATE TRIGGER feature_flag_audit_no_truncate BEFORE TRUNCATE ON "feature_flag_audit_events"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_feature_flag_audit_mutation()`);

    await runner.query(`DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'feature_flags'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'feature_flags'
              AND column_name = 'rolledBackFromVersion'
          ) THEN
            ALTER TABLE "feature_flags" ADD COLUMN "rolledBackFromVersion" integer;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'feature_flags'
              AND column_name = 'changeReason'
          ) THEN
            ALTER TABLE "feature_flags" ADD COLUMN "changeReason" text;
          END IF;
        END IF;
      END $$;`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      `DROP TRIGGER IF EXISTS feature_flag_version_immutable ON "feature_flag_versions"`,
    );
    await runner.query(
      `DROP TRIGGER IF EXISTS feature_flag_version_no_truncate ON "feature_flag_versions"`,
    );
    await runner.query(
      `DROP TRIGGER IF EXISTS feature_flag_audit_immutable ON "feature_flag_audit_events"`,
    );
    await runner.query(
      `DROP TRIGGER IF EXISTS feature_flag_audit_no_truncate ON "feature_flag_audit_events"`,
    );
    await runner.query(`DROP TABLE IF EXISTS "feature_flag_versions"`);
    await runner.query(`DROP TABLE IF EXISTS "feature_flag_audit_events"`);
    await runner.query(
      `DROP FUNCTION IF EXISTS reject_feature_flag_version_mutation()`,
    );
    await runner.query(
      `DROP FUNCTION IF EXISTS reject_feature_flag_audit_mutation()`,
    );
  }
}
