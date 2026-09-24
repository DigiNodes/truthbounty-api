import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-110 — Make Security Audit Logs Tamper Evident.
 *
 * Adds the columns and singleton state table needed for a real hash
 * chain over `audit_logs`:
 *
 * - `audit_logs.previousHash` / `audit_logs.chainSequence`: link each
 *   record to the one written before it.
 * - `audit_chain_state`: single-row table holding the chain tip
 *   (`lastHash`, `lastSequence`), locked with `SELECT ... FOR UPDATE`
 *   on every write so the chain can't fork under concurrency.
 *
 * Existing rows predate the chain and keep `previousHash`/`chainSequence`
 * NULL; `chainSequence` is only unique among non-null values (a partial
 * index), since a plain unique constraint would reject those NULLs.
 */
export class AddAuditLogHashChain1790000000000 implements MigrationInterface {
  name = 'AddAuditLogHashChain1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN "previousHash" VARCHAR NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD COLUMN "chainSequence" BIGINT NULL`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_audit_logs_chain_sequence" ON "audit_logs" ("chainSequence") WHERE "chainSequence" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_chain_sequence" ON "audit_logs" ("chainSequence")`,
    );

    await queryRunner.query(
      `CREATE TABLE "audit_chain_state" (
        "id" SMALLINT PRIMARY KEY,
        "lastHash" VARCHAR NULL,
        "lastSequence" BIGINT NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )`,
    );

    // Seed the single chain-state row. New audit writes take a row lock
    // on this record (SELECT ... FOR UPDATE) before computing the next
    // link, so it must exist before any chained write is attempted.
    await queryRunner.query(
      `INSERT INTO "audit_chain_state" ("id", "lastHash", "lastSequence") VALUES (1, NULL, 0)
       ON CONFLICT ("id") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_chain_state"`);
    await queryRunner.query(`DROP INDEX "IDX_audit_logs_chain_sequence"`);
    await queryRunner.query(`DROP INDEX "UQ_audit_logs_chain_sequence"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "chainSequence"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "previousHash"`);
  }
}
