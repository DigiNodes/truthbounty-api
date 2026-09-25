import { MigrationInterface, QueryRunner } from 'typeorm';

export class SafeRemovedLogsAndBlocks1725000001000 implements MigrationInterface {
    name = 'SafeRemovedLogsAndBlocks1725000001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "v2_indexer_cursors"
            ADD COLUMN IF NOT EXISTS "transaction_hash" VARCHAR(66),
            ADD COLUMN IF NOT EXISTS "log_index" INT NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS "safe_block_number" BIGINT,
            ADD COLUMN IF NOT EXISTS "finalized_block_number" BIGINT;`);

        await queryRunner.query(`CREATE TABLE "v2_indexer_blocks" (
            "id" SERIAL PRIMARY KEY,
            "chain_id" INT NOT NULL,
            "contract_address" VARCHAR(42) NOT NULL,
            "block_number" BIGINT NOT NULL,
            "block_hash" VARCHAR(66) NOT NULL,
            "status" VARCHAR(20) NOT NULL DEFAULT 'canonical',
            "seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "replaced_at" TIMESTAMP WITH TIME ZONE,
            CONSTRAINT "UQ_indexer_block_identity" UNIQUE ("chain_id", "contract_address", "block_number")
        );`);

        await queryRunner.query(`CREATE TABLE "v2_removed_logs" (
            "id" SERIAL PRIMARY KEY,
            "chain_id" INT NOT NULL,
            "contract_address" VARCHAR(42) NOT NULL,
            "block_number" BIGINT NOT NULL,
            "block_hash" VARCHAR(66) NOT NULL,
            "transaction_hash" VARCHAR(66) NOT NULL,
            "log_index" INT NOT NULL,
            "reason" TEXT NOT NULL,
            "removed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "UQ_removed_log_identity" UNIQUE ("chain_id", "contract_address", "transaction_hash", "log_index")
        );`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "v2_removed_logs";`);
        await queryRunner.query(`DROP TABLE "v2_indexer_blocks";`);
        await queryRunner.query(`ALTER TABLE "v2_indexer_cursors"
            DROP COLUMN IF EXISTS "transaction_hash",
            DROP COLUMN IF EXISTS "log_index",
            DROP COLUMN IF EXISTS "safe_block_number",
            DROP COLUMN IF EXISTS "finalized_block_number";`);
    }
}