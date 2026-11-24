import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Add eventSignature column to v2_canonical_events for production-grade
 * event keying that supports overloaded event names.
 * 
 * This migration supports the post-Wave-9 production-readiness requirement
 * to key events by canonical signature/topic0 instead of name alone.
 */
export class AddEventSignatureColumn1769900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'v2_canonical_events',
      new TableColumn({
        name: 'eventSignature',
        type: 'varchar',
        length: '256',
        isNullable: true,
        comment: 'Canonical event signature for overload disambiguation, e.g. Transfer(address,address,uint256)',
      }),
    );

    // Create index on eventSignature for efficient lookups
    await queryRunner.query(
      `CREATE INDEX "idx_v2_canonical_event_signature" ON "v2_canonical_events" ("eventSignature")`,
    );

    // Backfill existing rows with signature derived from eventName
    // This is a best-effort migration; overloaded events in historical data
    // will need manual review if they exist
    await queryRunner.query(
      `UPDATE "v2_canonical_events" SET "eventSignature" = "eventName" WHERE "eventSignature" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_v2_canonical_event_signature"`,
    );
    await queryRunner.dropColumn('v2_canonical_events', 'eventSignature');
  }
}
