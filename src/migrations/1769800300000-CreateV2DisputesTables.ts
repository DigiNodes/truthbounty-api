import { MigrationInterface, QueryRunner } from 'typeorm';

/** V2-BE-016: dispute/appeal lifecycle read model table. */
export class CreateV2DisputesTables1769800300000 implements MigrationInterface {
  name = 'CreateV2DisputesTables1769800300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_project_dispute" (
        "disputeId" varchar(200) PRIMARY KEY,
        "claimId" varchar(66) NOT NULL,
        "originalRoundId" varchar(66) NOT NULL,
        "appealRoundId" varchar(66) NULL,
        "challengeBond" varchar(100) NULL,
        "challengeBondAsset" varchar(42) NULL,
        "status" varchar(16) NOT NULL DEFAULT 'raised',
        "deadline" TIMESTAMP NULL,
        "resolvedOutcome" varchar(64) NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_v2_project_dispute_claim_id" ON "v2_project_dispute" ("claimId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_project_dispute"`);
  }
}
