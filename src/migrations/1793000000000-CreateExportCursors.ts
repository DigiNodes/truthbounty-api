import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `export_cursors` table, which stores the resumable state for
 * cursor-based audit exports (PREWAVE-BE-033).
 *
 * Security constraints enforced at the DB layer:
 *   - `expiresAt > createdAt`  — cursors must have a positive TTL
 *   - `pagesFetched >= 0`      — counter is monotonically non-negative
 *   - `rowsExported >= 0`      — same
 *   - `status` is constrained to known values so ORM bugs can't
 *     introduce undefined state that the capability guard would have
 *     to handle.
 *
 * Append-only audit invariant does NOT apply here because the cursor row
 * is explicitly mutable (status transitions, progress counters) and is
 * NOT part of the tamper-evident hash chain.  The row is deleted after
 * the export completes or expires.
 */
export class CreateExportCursors1793000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const dialect = runner.connection.options.type;
    const isPostgres = dialect === 'postgres';

    if (isPostgres) {
      await runner.query(`
        CREATE TABLE "export_cursors" (
          "id"            uuid            NOT NULL DEFAULT gen_random_uuid(),
          "requesterId"   uuid            NOT NULL,
          "status"        varchar(32)     NOT NULL DEFAULT 'active',
          "filters"       jsonb           NOT NULL DEFAULT '{}',
          "lastSeq"       bigint          NOT NULL DEFAULT 0,
          "lastId"        uuid                     NULL,
          "pagesFetched"  integer         NOT NULL DEFAULT 0,
          "rowsExported"  bigint          NOT NULL DEFAULT 0,
          "checkpointHash" varchar(64)             NULL,
          "format"        varchar(16)     NOT NULL DEFAULT 'json',
          "exportVersion" varchar(8)      NOT NULL DEFAULT '1',
          "createdAt"     timestamptz     NOT NULL DEFAULT now(),
          "updatedAt"     timestamptz     NOT NULL DEFAULT now(),
          "expiresAt"     timestamptz     NOT NULL,
          CONSTRAINT "pk_export_cursors"          PRIMARY KEY ("id"),
          CONSTRAINT "chk_export_cursor_status"   CHECK ("status" IN ('active','cancelled','exhausted','expired')),
          CONSTRAINT "chk_export_cursor_ttl"      CHECK ("expiresAt" > "createdAt"),
          CONSTRAINT "chk_export_pages_nn"        CHECK ("pagesFetched" >= 0),
          CONSTRAINT "chk_export_rows_nn"         CHECK ("rowsExported" >= 0)
        )
      `);

      await runner.query(
        `CREATE INDEX "idx_export_cursors_requester" ON "export_cursors" ("requesterId", "status")`,
      );
      await runner.query(
        `CREATE INDEX "idx_export_cursors_expires" ON "export_cursors" ("expiresAt")`,
      );
    } else {
      // SQLite path (tests / local dev only)
      await runner.query(`
        CREATE TABLE "export_cursors" (
          "id"            varchar(36)     NOT NULL PRIMARY KEY,
          "requesterId"   varchar(36)     NOT NULL,
          "status"        varchar(32)     NOT NULL DEFAULT 'active',
          "filters"       text            NOT NULL DEFAULT '{}',
          "lastSeq"       integer         NOT NULL DEFAULT 0,
          "lastId"        varchar(36)              NULL,
          "pagesFetched"  integer         NOT NULL DEFAULT 0,
          "rowsExported"  integer         NOT NULL DEFAULT 0,
          "checkpointHash" varchar(64)             NULL,
          "format"        varchar(16)     NOT NULL DEFAULT 'json',
          "exportVersion" varchar(8)      NOT NULL DEFAULT '1',
          "createdAt"     datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt"     datetime        NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "expiresAt"     datetime        NOT NULL,
          CHECK ("status" IN ('active','cancelled','exhausted','expired')),
          CHECK ("pagesFetched" >= 0),
          CHECK ("rowsExported" >= 0)
        )
      `);

      await runner.query(
        `CREATE INDEX "idx_export_cursors_requester" ON "export_cursors" ("requesterId", "status")`,
      );
      await runner.query(
        `CREATE INDEX "idx_export_cursors_expires" ON "export_cursors" ("expiresAt")`,
      );
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS "export_cursors"`);
  }
}
