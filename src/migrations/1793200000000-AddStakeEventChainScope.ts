import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStakeEventChainScope1793200000000 implements MigrationInterface {
  name = 'AddStakeEventChainScope1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "stake_event"
      ADD COLUMN IF NOT EXISTS "chainId" INTEGER NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "stake_event"
      ADD COLUMN IF NOT EXISTS "contractAddress" VARCHAR(42) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_stake_event_chain_scope"
      ON "stake_event" ("chainId", "contractAddress", "blockNumber")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_stake_event_chain_scope"
    `);
    await queryRunner.query(`
      ALTER TABLE "stake_event"
      DROP COLUMN IF EXISTS "contractAddress"
    `);
    await queryRunner.query(`
      ALTER TABLE "stake_event"
      DROP COLUMN IF EXISTS "chainId"
    `);
  }
}
