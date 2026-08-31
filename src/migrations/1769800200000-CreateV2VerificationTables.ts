import { MigrationInterface, QueryRunner } from 'typeorm';

/** V2-BE-014: verification round/position read model tables, plus the shared anomaly log. */
export class CreateV2VerificationTables1769800200000 implements MigrationInterface {
  name = 'CreateV2VerificationTables1769800200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_indexing_anomalies" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sourceModule" varchar(64) NOT NULL,
        "kind" varchar(32) NOT NULL,
        "aggregateId" varchar(128) NOT NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "detail" text NOT NULL,
        "detectedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_indexing_anomalies_source_kind" ON "v2_indexing_anomalies" ("sourceModule", "kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_v2_indexing_anomalies_aggregate_id" ON "v2_indexing_anomalies" ("aggregateId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "v2_project_verification_round" (
        "roundId" varchar(66) PRIMARY KEY,
        "claimId" varchar(66) NOT NULL,
        "roundType" varchar(16) NOT NULL,
        "roundNumber" integer NOT NULL,
        "deadline" TIMESTAMP NULL,
        "status" varchar(16) NOT NULL DEFAULT 'open',
        "openedAtBlock" bigint NOT NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_round_sequence" UNIQUE ("claimId", "roundType", "roundNumber")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_verification_round_claim_id" ON "v2_project_verification_round" ("claimId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "v2_project_participant_position" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "roundId" varchar(66) NOT NULL,
        "participant" varchar(42) NOT NULL,
        "stake" varchar(100) NOT NULL,
        "reputationInput" varchar(100) NULL,
        "effectiveWeight" varchar(100) NULL,
        "position" varchar(32) NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_position_event" UNIQUE ("eventTxHash", "eventLogIndex"),
        CONSTRAINT "uq_v2_position_participant_round" UNIQUE ("roundId", "participant")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_participant_position_round_id" ON "v2_project_participant_position" ("roundId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_project_participant_position"`);
    await queryRunner.query(`DROP TABLE "v2_project_verification_round"`);
    await queryRunner.query(`DROP TABLE "v2_indexing_anomalies"`);
  }
}
