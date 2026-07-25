import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvidenceVersionColumns1769600000000 implements MigrationInterface {
  name = 'AddEvidenceVersionColumns1769600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evidence_versions" ADD COLUMN "hash" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "evidence_versions" ADD COLUMN "submittedBy" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evidence_versions" DROP COLUMN "submittedBy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "evidence_versions" DROP COLUMN "hash"`,
    );
  }
}
