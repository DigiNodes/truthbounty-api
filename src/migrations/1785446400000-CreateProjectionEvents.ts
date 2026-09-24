import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the realtime projection outbox table.
 *
 * Rows are written within the same database transaction as the projection
 * change; the monotonically increasing `id` is the resume/replay cursor, and
 * `published` marks rows already broadcast to the realtime stream.
 */
export class CreateProjectionEvents1785446400000 implements MigrationInterface {
  name = 'CreateProjectionEvents1785446400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "projection_events" (
        "id" BIGSERIAL NOT NULL,
        "aggregate_type" character varying(128) NOT NULL,
        "aggregate_id" character varying(128) NOT NULL,
        "event_type" character varying(32) NOT NULL,
        "payload" text NOT NULL,
        "finalized" boolean NOT NULL DEFAULT false,
        "published" boolean NOT NULL DEFAULT false,
        "published_at" TIMESTAMP NULL,
        "correlation_id" character varying(128),
        "revision" BIGINT NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_projection_events_id" PRIMARY KEY ("id")
      )
    `);

    // Efficient claim queries: un-published rows in id order, and historical
    // replay by cursor + aggregate lookup.
    await queryRunner.query(`
      CREATE INDEX "IDX_projection_events_published_id"
        ON "projection_events" ("published", "id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_projection_events_aggregate"
        ON "projection_events" ("aggregate_type", "aggregate_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_projection_events_revision"
        ON "projection_events" ("revision")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_projection_events_revision"`);
    await queryRunner.query(`DROP INDEX "IDX_projection_events_aggregate"`);
    await queryRunner.query(`DROP INDEX "IDX_projection_events_published_id"`);
    await queryRunner.query(`DROP TABLE "projection_events"`);
  }
}
