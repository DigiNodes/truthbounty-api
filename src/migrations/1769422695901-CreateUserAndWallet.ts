import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateUserAndWallet1769422695901 implements MigrationInterface {
    name = 'CreateUserAndWallet1769422695901'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "walletAddress" character varying NOT NULL, "reputation" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_fc71cd6fb73f95244b23e2ef113" UNIQUE ("walletAddress"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fc71cd6fb73f95244b23e2ef11" ON "users" ("walletAddress") `);
        await queryRunner.query(`CREATE TABLE "wallets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "address" character varying NOT NULL, "chain" character varying NOT NULL, "userId" uuid NOT NULL, "linkedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_d2ca61ed86d8413c262fad473ee" UNIQUE ("address", "chain"), CONSTRAINT "PK_8402e5df5a30a229380e83e4f7e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f907d5fd09a9d374f1da4e13bd" ON "wallets" ("address") `);
        await queryRunner.query(`CREATE TABLE "indexing_state" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "chainId" integer NOT NULL, "contractAddress" character varying(42) NOT NULL, "eventType" character varying(255) NOT NULL, "lastProcessedBlockNumber" bigint NOT NULL, "lastScannedBlockNumber" bigint NOT NULL DEFAULT '0', "lastFinalizedBlockNumber" bigint, "status" character varying(50) NOT NULL DEFAULT 'idle', "errorMessage" text, "totalEventCount" bigint NOT NULL DEFAULT '0', "processedEventCount" bigint NOT NULL DEFAULT '0', "failedEventCount" integer NOT NULL DEFAULT '0', "blockRangePerBatch" integer NOT NULL DEFAULT '5000', "confirmationsRequired" integer NOT NULL DEFAULT '12', "maxRetryAttempts" integer NOT NULL DEFAULT '3', "lastIndexedAt" TIMESTAMP, "lastSyncedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ceff7714d5a3f97646a45a5ead4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_542f11cfde8ebf6631fbf87eca" ON "indexing_state" ("chainId", "contractAddress", "eventType") `);
        await queryRunner.query(`CREATE TABLE "indexed_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventType" character varying(255) NOT NULL, "contractAddress" character varying(42) NOT NULL, "transactionHash" character varying(66) NOT NULL, "blockNumber" bigint NOT NULL, "logIndex" integer NOT NULL, "chainId" integer NOT NULL, "eventData" jsonb NOT NULL, "parsedData" jsonb NOT NULL, "confirmations" integer NOT NULL DEFAULT '0', "isFinalized" boolean NOT NULL DEFAULT false, "isProcessed" boolean NOT NULL DEFAULT false, "processedAt" TIMESTAMP, "processingError" text, "retryAttempts" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_efed6f796c0f8591da1d7b02573" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c5e04b4ec8d8e93e87174f23f9" ON "indexed_events" ("processedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_67529cdee4b7baae9afe6db6a4" ON "indexed_events" ("eventType", "blockNumber") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_21bb848bab721f9075b3bd4d4f" ON "indexed_events" ("transactionHash", "logIndex", "eventType") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_490a5e2198a18f9d760f24b5ec" ON "indexed_events" ("blockNumber", "logIndex") `);
        await queryRunner.query(`CREATE TABLE "stake" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "walletAddress" character varying NOT NULL, "claimId" character varying NOT NULL, "amount" numeric(78,0) NOT NULL, "lastTxHash" character varying NOT NULL, "updatedAt" TIMESTAMP NOT NULL, CONSTRAINT "PK_8cfd82a65916af9d517d25a894e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2e0482d6d9db9f4f5818614cdf" ON "stake" ("walletAddress", "claimId") `);
        await queryRunner.query(`CREATE TYPE "public"."stake_event_type_enum" AS ENUM('STAKE_DEPOSITED', 'STAKE_WITHDRAWN', 'STAKE_SLASHED')`);
        await queryRunner.query(`CREATE TABLE "stake_event" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "walletAddress" character varying NOT NULL, "claimId" character varying NOT NULL, "type" "public"."stake_event_type_enum" NOT NULL, "amount" numeric(78,0) NOT NULL, "txHash" character varying NOT NULL, "blockNumber" integer NOT NULL, "timestamp" TIMESTAMP NOT NULL, CONSTRAINT "PK_991cc0713b262d0c22242590628" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f8a0f5defd17339ea1df0a9dce" ON "stake_event" ("txHash") `);
        await queryRunner.query(`CREATE TYPE "public"."disputes_status_enum" AS ENUM('OPEN', 'REVIEWING', 'RESOLVED', 'REJECTED')`);
        await queryRunner.query(`CREATE TYPE "public"."disputes_trigger_enum" AS ENUM('LOW_CONFIDENCE', 'MINORITY_OPPOSITION', 'MANUAL')`);
        await queryRunner.query(`CREATE TYPE "public"."disputes_outcome_enum" AS ENUM('CONFIRMED', 'OVERTURNED')`);
        await queryRunner.query(`CREATE TABLE "disputes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "claimId" character varying NOT NULL, "status" "public"."disputes_status_enum" NOT NULL DEFAULT 'OPEN', "trigger" "public"."disputes_trigger_enum" NOT NULL, "originalConfidence" numeric(5,2) NOT NULL, "finalConfidence" numeric(5,2), "outcome" "public"."disputes_outcome_enum", "initiatorId" character varying, "metadata" jsonb NOT NULL DEFAULT '{}', "reviewStartedAt" TIMESTAMP, "resolvedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_3c97580d01c1a4b0b345c42a107" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "claims" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "resolvedVerdict" boolean, "confidenceScore" numeric(5,4), "finalized" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_96c91970c0dcb2f69fdccd0a698" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "token_balances" ("id" SERIAL NOT NULL, "address" character varying(42) NOT NULL, "token_address" character varying(42) NOT NULL, "balance" numeric(36,18) NOT NULL DEFAULT '0', "last_updated" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_b367642ea41906418425c9217c3" UNIQUE ("address", "token_address"), CONSTRAINT "PK_e12dc361a93cf25efa25d0a4cdc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "processed_events" ("id" SERIAL NOT NULL, "tx_hash" character varying(66) NOT NULL, "log_index" integer NOT NULL, "block_number" bigint NOT NULL, "event_type" character varying(100) NOT NULL, "processed_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_f4bfa3c06d08fd9e7f7a611a7e9" UNIQUE ("tx_hash", "log_index", "block_number"), CONSTRAINT "PK_a08d68aa0747daea9efd2ddea53" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "indexer_checkpoint" ("id" SERIAL NOT NULL, "last_block" bigint NOT NULL, "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2352e5508f3b4ecc6cf876fe808" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "wallets" ADD CONSTRAINT "FK_2ecdb33f23e9a6fc392025c0b97" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallets" DROP CONSTRAINT "FK_2ecdb33f23e9a6fc392025c0b97"`);
        await queryRunner.query(`DROP TABLE "indexer_checkpoint"`);
        await queryRunner.query(`DROP TABLE "processed_events"`);
        await queryRunner.query(`DROP TABLE "token_balances"`);
        await queryRunner.query(`DROP TABLE "claims"`);
        await queryRunner.query(`DROP TABLE "disputes"`);
        await queryRunner.query(`DROP TYPE "public"."disputes_outcome_enum"`);
        await queryRunner.query(`DROP TYPE "public"."disputes_trigger_enum"`);
        await queryRunner.query(`DROP TYPE "public"."disputes_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f8a0f5defd17339ea1df0a9dce"`);
        await queryRunner.query(`DROP TABLE "stake_event"`);
        await queryRunner.query(`DROP TYPE "public"."stake_event_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2e0482d6d9db9f4f5818614cdf"`);
        await queryRunner.query(`DROP TABLE "stake"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_490a5e2198a18f9d760f24b5ec"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_21bb848bab721f9075b3bd4d4f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_67529cdee4b7baae9afe6db6a4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c5e04b4ec8d8e93e87174f23f9"`);
        await queryRunner.query(`DROP TABLE "indexed_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_542f11cfde8ebf6631fbf87eca"`);
        await queryRunner.query(`DROP TABLE "indexing_state"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f907d5fd09a9d374f1da4e13bd"`);
        await queryRunner.query(`DROP TABLE "wallets"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fc71cd6fb73f95244b23e2ef11"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
