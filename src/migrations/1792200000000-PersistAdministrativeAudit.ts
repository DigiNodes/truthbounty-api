import { MigrationInterface, QueryRunner } from 'typeorm';

export class PersistAdministrativeAudit1792200000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type !== 'postgres') {
      throw new Error('Administrative audit persistence requires PostgreSQL');
    }
    await runner.query(`CREATE TABLE "admin_audit_head" (
      "id" smallint NOT NULL PRIMARY KEY,
      "lastSequence" bigint NOT NULL DEFAULT '0',
      "lastHash" varchar NULL,
      CONSTRAINT "chk_admin_audit_single_head" CHECK ("id" = 1)
    )`);
    await runner.query(`INSERT INTO "admin_audit_head" ("id") VALUES (1)`);
    await runner.query(`CREATE TABLE "admin_audit_logs" (
      "eventId" uuid NOT NULL PRIMARY KEY,
      "chainSequence" bigint NOT NULL,
      "timestamp" timestamptz NOT NULL,
      "retentionUntil" timestamptz NOT NULL,
      "actorId" uuid NOT NULL,
      "actorType" varchar NOT NULL,
      "action" varchar NOT NULL,
      "actionCategory" varchar NOT NULL,
      "targetType" varchar NOT NULL,
      "targetId" uuid NOT NULL,
      "capability" varchar NOT NULL,
      "authoritySource" varchar NOT NULL,
      "authorityReference" uuid NOT NULL,
      "requestReference" uuid NOT NULL,
      "correlationId" uuid NOT NULL,
      "outcome" varchar NOT NULL,
      "severity" varchar NOT NULL,
      "resultReference" uuid NULL,
      "chainContext" jsonb NULL,
      "integrityHash" varchar NOT NULL,
      "previousHash" varchar NULL,
      CONSTRAINT "chk_admin_audit_sequence" CHECK ("chainSequence" > 0),
      CONSTRAINT "chk_admin_audit_retention" CHECK ("retentionUntil" >= "timestamp"),
      CONSTRAINT "chk_admin_audit_outcome" CHECK ("outcome" IN ('attempted','success','failure','partial','rolled_back','unknown'))
    )`);
    await runner.query(
      `CREATE UNIQUE INDEX "uq_admin_audit_sequence" ON "admin_audit_logs" ("chainSequence")`,
    );
    await runner.query(
      `CREATE INDEX "idx_admin_audit_correlation" ON "admin_audit_logs" ("correlationId", "chainSequence")`,
    );
    await runner.query(
      `CREATE INDEX "idx_admin_audit_actor_time" ON "admin_audit_logs" ("actorId", "timestamp")`,
    );
    await runner.query(`CREATE FUNCTION reject_admin_audit_mutation() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Administrative audit records are append-only'; END;
    $$ LANGUAGE plpgsql`);
    await runner.query(`CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON "admin_audit_logs"
      FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation()`);
    await runner.query(`CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON "admin_audit_logs"
      FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation()`);
  }

  /** Destructive rollback: export records and obtain operator approval first. */
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "admin_audit_logs"`);
    await runner.query(`DROP TABLE "admin_audit_head"`);
    await runner.query(`DROP FUNCTION reject_admin_audit_mutation()`);
  }
}
