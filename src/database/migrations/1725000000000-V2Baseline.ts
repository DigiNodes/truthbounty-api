// src/database/migrations/1725000000000-V2Baseline.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class V2Baseline1725000000000 implements MigrationInterface {
    name = 'V2Baseline1725000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Audit tables
        await queryRunner.query(`
            CREATE TABLE "v2_audit_logs" (
                "id" SERIAL PRIMARY KEY,
                "actor" VARCHAR(42) NOT NULL,
                "action" VARCHAR(100) NOT NULL,
                "metadata" JSONB NOT NULL DEFAULT '{}',
                "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Cursor tables for indexer sync
        await queryRunner.query(`
            CREATE TABLE "v2_indexer_cursors" (
                "id" SERIAL PRIMARY KEY,
                "chain_id" INT NOT NULL,
                "contract_address" VARCHAR(42) NOT NULL,
                "last_block_number" BIGINT NOT NULL,
                "block_hash" VARCHAR(66) NOT NULL,
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "UQ_cursor_chain_contract" UNIQUE ("chain_id", "contract_address")
            );
        `);

        // 3. Projection tables for event-derived state
        await queryRunner.query(`
            CREATE TABLE "v2_projections" (
                "id" SERIAL PRIMARY KEY,
                "entity_type" VARCHAR(50) NOT NULL,
                "entity_id" VARCHAR(66) NOT NULL,
                "state_data" JSONB NOT NULL,
                "version" BIGINT NOT NULL,
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "UQ_projection_entity" UNIQUE ("entity_type", "entity_id")
            );
        `);

        // 4. Auth tables
        await queryRunner.query(`
            CREATE TABLE "v2_auth_nonces" (
                "id" SERIAL PRIMARY KEY,
                "wallet_address" VARCHAR(42) NOT NULL,
                "nonce" VARCHAR(255) NOT NULL,
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "used" BOOLEAN NOT NULL DEFAULT FALSE,
                CONSTRAINT "UQ_wallet_nonce" UNIQUE ("wallet_address", "nonce")
            );
        `);

        // 5. Schema version metadata table
        await queryRunner.query(`
            CREATE TABLE "v2_schema_versions" (
                "version" INT PRIMARY KEY,
                "applied_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO "v2_schema_versions" ("version") VALUES (2);
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "v2_schema_versions";`);
        await queryRunner.query(`DROP TABLE "v2_auth_nonces";`);
        await queryRunner.query(`DROP TABLE "v2_projections";`);
        await queryRunner.query(`DROP TABLE "v2_indexer_cursors";`);
        await queryRunner.query(`DROP TABLE "v2_audit_logs";`);
    }
}