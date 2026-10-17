import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UX-BE-002 (#592): Public Incident Projection persistence.
 *
 * Separate sanitized table for publishable incident records and audit history.
 * Does not contain protected investigation notes, internal reporter IDs,
 * unapproved drafts, or secret credentials.
 */
export class CreatePublicIncidentProjections1792400000000
  implements MigrationInterface
{
  name = 'CreatePublicIncidentProjections1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "public_incident_projections" (
          "id" uuid NOT NULL DEFAULT gen_random_uuid(),
          "incidentId" varchar(255) NULL,
          "slug" varchar(200) NULL,
          "title" varchar(200) NOT NULL,
          "status" varchar(32) NOT NULL DEFAULT 'investigating',
          "impact" varchar(32) NOT NULL DEFAULT 'minor',
          "affectedComponents" json NOT NULL DEFAULT '[]',
          "description" text NOT NULL,
          "mitigation" text NULL,
          "postIncidentLinks" json NULL,
          "publicationHistory" json NOT NULL DEFAULT '[]',
          "isApproved" boolean NOT NULL DEFAULT false,
          "isDraft" boolean NOT NULL DEFAULT true,
          "approvedBy" varchar(255) NULL,
          "approvedAt" timestamptz NULL,
          "publicationSequence" integer NOT NULL DEFAULT 1,
          "startedAt" timestamptz NOT NULL,
          "publishedAt" timestamptz NULL,
          "resolvedAt" timestamptz NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "PK_public_incident_projections_id" PRIMARY KEY ("id")
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "public_incident_projections" (
          "id" varchar(36) NOT NULL PRIMARY KEY,
          "incidentId" varchar(255) NULL,
          "slug" varchar(200) NULL,
          "title" varchar(200) NOT NULL,
          "status" varchar(32) NOT NULL DEFAULT 'investigating',
          "impact" varchar(32) NOT NULL DEFAULT 'minor',
          "affectedComponents" text NOT NULL DEFAULT '[]',
          "description" text NOT NULL,
          "mitigation" text NULL,
          "postIncidentLinks" text NULL,
          "publicationHistory" text NOT NULL DEFAULT '[]',
          "isApproved" boolean NOT NULL DEFAULT 0,
          "isDraft" boolean NOT NULL DEFAULT 1,
          "approvedBy" varchar(255) NULL,
          "approvedAt" datetime NULL,
          "publicationSequence" integer NOT NULL DEFAULT 1,
          "startedAt" datetime NOT NULL,
          "publishedAt" datetime NULL,
          "resolvedAt" datetime NULL,
          "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_public_incidents_status"
      ON "public_incident_projections" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_public_incidents_isApproved"
      ON "public_incident_projections" ("isApproved")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_public_incidents_isDraft"
      ON "public_incident_projections" ("isDraft")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_public_incidents_publishedAt"
      ON "public_incident_projections" ("publishedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_public_incidents_createdAt"
      ON "public_incident_projections" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_public_incidents_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_public_incidents_publishedAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_public_incidents_isDraft"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_public_incidents_isApproved"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_public_incidents_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "public_incident_projections"`);
  }
}
