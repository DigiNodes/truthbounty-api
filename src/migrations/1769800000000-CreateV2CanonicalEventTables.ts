import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V2-BE-011: canonical event decode/normalize pipeline tables.
 *
 * v2_contract_artifacts and v2_event_checkpoints are minimal stand-ins for
 * the not-yet-merged V2-BE-008 / V2-BE-010 interfaces (see PR description).
 */
export class CreateV2CanonicalEventTables1769800000000 implements MigrationInterface {
  name = 'CreateV2CanonicalEventTables1769800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_contract_artifacts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "chainId" integer NOT NULL,
        "contractAddress" varchar(42) NOT NULL,
        "artifactVersion" varchar(64) NOT NULL,
        "abi" json NOT NULL,
        "isApproved" boolean NOT NULL DEFAULT false,
        "registeredAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_contract_artifact_address" UNIQUE ("chainId", "contractAddress")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_contract_artifacts_is_approved" ON "v2_contract_artifacts" ("isApproved")`,
    );

    await queryRunner.query(`
      CREATE TABLE "v2_event_checkpoints" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "chainId" integer NOT NULL,
        "contractAddress" varchar(42) NOT NULL,
        "lastSafeBlock" bigint NOT NULL DEFAULT 0,
        "lastFinalizedBlock" bigint NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_checkpoint_source" UNIQUE ("chainId", "contractAddress")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "v2_canonical_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "chainId" integer NOT NULL,
        "contractAddress" varchar(42) NOT NULL,
        "artifactVersion" varchar(64) NOT NULL,
        "eventName" varchar(128) NOT NULL,
        "txHash" varchar(66) NOT NULL,
        "logIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "blockTimestamp" TIMESTAMP NULL,
        "actor" varchar(42) NULL,
        "claimId" varchar(66) NULL,
        "roundId" varchar(66) NULL,
        "asset" varchar(42) NULL,
        "amount" varchar(100) NULL,
        "payload" json NOT NULL,
        "rawArgs" json NOT NULL,
        "ingestedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_canonical_event_identity" UNIQUE ("chainId", "txHash", "logIndex")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_canonical_events_block_log" ON "v2_canonical_events" ("blockNumber", "logIndex")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_canonical_events_name_block" ON "v2_canonical_events" ("eventName", "blockNumber")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_v2_canonical_events_claim_id" ON "v2_canonical_events" ("claimId")`);
    await queryRunner.query(`CREATE INDEX "idx_v2_canonical_events_round_id" ON "v2_canonical_events" ("roundId")`);

    await queryRunner.query(`
      CREATE TABLE "v2_event_quarantine" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "chainId" integer NOT NULL,
        "contractAddress" varchar(42) NOT NULL,
        "txHash" varchar(66) NOT NULL,
        "logIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "topic0" varchar(66) NULL,
        "reason" varchar(32) NOT NULL,
        "rawLog" json NOT NULL,
        "detail" text NULL,
        "quarantinedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_quarantine_identity" UNIQUE ("chainId", "txHash", "logIndex")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_v2_event_quarantine_reason" ON "v2_event_quarantine" ("reason")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_event_quarantine"`);
    await queryRunner.query(`DROP TABLE "v2_canonical_events"`);
    await queryRunner.query(`DROP TABLE "v2_event_checkpoints"`);
    await queryRunner.query(`DROP TABLE "v2_contract_artifacts"`);
  }
}
