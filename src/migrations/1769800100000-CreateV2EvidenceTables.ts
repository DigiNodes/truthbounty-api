import { MigrationInterface, QueryRunner } from 'typeorm';

/** V2-BE-013: evidence read model tables, plus the shared projector cursor table. */
export class CreateV2EvidenceTables1769800100000 implements MigrationInterface {
  name = 'CreateV2EvidenceTables1769800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "v2_projector_cursors" (
        "projectorName" varchar(64) PRIMARY KEY,
        "lastBlockNumber" bigint NOT NULL DEFAULT 0,
        "lastLogIndex" integer NOT NULL DEFAULT -1,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "v2_project_evidence" (
        "evidenceId" varchar(128) PRIMARY KEY,
        "claimId" varchar(66) NOT NULL,
        "currentVersion" integer NOT NULL DEFAULT 1,
        "status" varchar(16) NOT NULL DEFAULT 'active',
        "contentDigest" varchar(66) NOT NULL,
        "lastEventBlockNumber" bigint NOT NULL,
        "lastEventLogIndex" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_v2_project_evidence_claim_id" ON "v2_project_evidence" ("claimId")`);

    await queryRunner.query(`
      CREATE TABLE "v2_project_evidence_version" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "evidenceId" varchar(128) NOT NULL,
        "version" integer NOT NULL,
        "contentDigest" varchar(66) NOT NULL,
        "safeMetadataUri" varchar(512) NULL,
        "submittedBy" varchar(42) NULL,
        "eventTxHash" varchar(66) NOT NULL,
        "eventLogIndex" integer NOT NULL,
        "blockNumber" bigint NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "uq_v2_evidence_version" UNIQUE ("evidenceId", "version"),
        CONSTRAINT "uq_v2_evidence_version_event" UNIQUE ("eventTxHash", "eventLogIndex")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_v2_project_evidence_version_evidence_id" ON "v2_project_evidence_version" ("evidenceId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "v2_project_evidence_version"`);
    await queryRunner.query(`DROP TABLE "v2_project_evidence"`);
    await queryRunner.query(`DROP TABLE "v2_projector_cursors"`);
  }
}
