import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PREWAVE-BE-053 (#647): add replay state, bounded provenance metadata and
 * retention to the canonical-event quarantine.
 *
 * Backward compatible: existing rows become `status = 'open'` and keep their
 * `rawLog`, so readiness stays fail-closed until they are reviewed.
 */
export class AddEventQuarantineReplayState1793100000000 implements MigrationInterface {
  name = 'AddEventQuarantineReplayState1793100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const add = async (sql: string) => {
      try {
        await queryRunner.query(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Idempotent for environments where the column already exists.
        if (!/already exists|duplicate column/i.test(message)) throw error;
      }
    };

    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "failureKind" varchar(32)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "status" varchar(16) NOT NULL DEFAULT 'open'`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "artifactVersion" varchar(64)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "abiChecksum" varchar(64)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "eventSignature" varchar(128)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "dataHash" varchar(66)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "dataLength" int`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "topicCount" int`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "replayAttempts" int NOT NULL DEFAULT 0`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "replayedAt" timestamp`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "replayedBy" varchar(128)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "lastReplayErrorCode" varchar(64)`,
    );
    await add(
      `ALTER TABLE "v2_event_quarantine" ADD COLUMN IF NOT EXISTS "retentionUntil" timestamp`,
    );

    // Replay needs the raw log; after replay it is scrubbed to NULL.
    await add(
      `ALTER TABLE "v2_event_quarantine" ALTER COLUMN "rawLog" DROP NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" DROP CONSTRAINT IF EXISTS "chk_v2_quarantine_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" ADD CONSTRAINT "chk_v2_quarantine_reason" CHECK ("reason" IN ('unregistered_address','unknown_signature','artifact_drift','decode_error','abi_mismatch'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" DROP CONSTRAINT IF EXISTS "chk_v2_quarantine_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" ADD CONSTRAINT "chk_v2_quarantine_status" CHECK ("status" IN ('open','replayed'))`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_v2_event_quarantine_status_reason" ON "v2_event_quarantine" ("status", "reason")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_v2_event_quarantine_status_time" ON "v2_event_quarantine" ("status", "quarantinedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_event_quarantine_status_time"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_event_quarantine_status_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" DROP CONSTRAINT IF EXISTS "chk_v2_quarantine_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" DROP CONSTRAINT IF EXISTS "chk_v2_quarantine_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "v2_event_quarantine" ADD CONSTRAINT "chk_v2_quarantine_reason" CHECK ("reason" IN ('unregistered_address','unknown_signature','artifact_drift','decode_error'))`,
    );
    for (const column of [
      'retentionUntil',
      'lastReplayErrorCode',
      'replayedBy',
      'replayedAt',
      'replayAttempts',
      'topicCount',
      'dataLength',
      'dataHash',
      'eventSignature',
      'abiChecksum',
      'artifactVersion',
      'status',
      'failureKind',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "v2_event_quarantine" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
