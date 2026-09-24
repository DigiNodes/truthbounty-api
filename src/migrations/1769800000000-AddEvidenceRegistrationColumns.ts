import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvidenceRegistrationColumns1769800000000 implements MigrationInterface {
  name = 'AddEvidenceRegistrationColumns1769800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evidences" ADD COLUMN "onChainRegistered" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "evidences" ADD COLUMN "blockNumber" numeric`,
    );
    await queryRunner.query(
      `ALTER TABLE "evidences" ADD COLUMN "transactionHash" varchar(66)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evidences" DROP COLUMN "transactionHash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "evidences" DROP COLUMN "blockNumber"`,
    );
    await queryRunner.query(
      `ALTER TABLE "evidences" DROP COLUMN "onChainRegistered"`,
    );
  }
}
