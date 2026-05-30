import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdjustProcessedEventUniqueIndex1769500000001 implements MigrationInterface {
    name = 'AdjustProcessedEventUniqueIndex1769500000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "processed_events" DROP CONSTRAINT "UQ_f4bfa3c06d08fd9e7f7a611a7e9"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_processed_events_tx_hash_log_index" ON "processed_events" ("tx_hash", "log_index")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_processed_events_tx_hash_log_index"`);
        await queryRunner.query(`ALTER TABLE "processed_events" ADD CONSTRAINT "UQ_f4bfa3c06d08fd9e7f7a611a7e9" UNIQUE ("tx_hash", "log_index", "block_number")`);
    }
}
