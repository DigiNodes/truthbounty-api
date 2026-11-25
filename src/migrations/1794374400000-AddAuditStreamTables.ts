import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddAuditStreamTables1794374400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create audit_stream_records table
    await queryRunner.createTable(
      new Table({
        name: 'audit_stream_records',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            isPrimary: true,
          },
          {
            name: 'stream_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'sequence',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'previous_hash',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'payload_hash',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'hmac_signature',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'key_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'timestamp',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
        uniques: [
          {
            name: 'uq_audit_stream_records_stream_sequence',
            columnNames: ['stream_id', 'sequence'],
          },
        ],
      }),
      true,
    );

    // Create indexes for audit_stream_records
    await queryRunner.createIndex(
      'audit_stream_records',
      new TableIndex({
        name: 'idx_audit_stream_records_stream_sequence',
        columnNames: ['stream_id', 'sequence'],
      }),
    );

    await queryRunner.createIndex(
      'audit_stream_records',
      new TableIndex({
        name: 'idx_audit_stream_records_stream_created',
        columnNames: ['stream_id', 'created_at'],
      }),
    );

    // Create audit_stream_checkpoints table
    await queryRunner.createTable(
      new Table({
        name: 'audit_stream_checkpoints',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            isPrimary: true,
          },
          {
            name: 'stream_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'sequence',
            type: 'integer',
            isNullable: false,
          },
          {
            name: 'head_hash',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'key_id',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
        uniques: [
          {
            name: 'uq_audit_stream_checkpoints_stream',
            columnNames: ['stream_id'],
          },
        ],
      }),
      true,
    );

    // Create indexes for audit_stream_checkpoints
    await queryRunner.createIndex(
      'audit_stream_checkpoints',
      new TableIndex({
        name: 'idx_audit_stream_checkpoints_stream_sequence',
        columnNames: ['stream_id', 'sequence'],
      }),
    );

    // Create audit_key_metadata table
    await queryRunner.createTable(
      new Table({
        name: 'audit_key_metadata',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            isPrimary: true,
          },
          {
            name: 'key_id',
            type: 'varchar',
            isNullable: false,
            isUnique: true,
          },
          {
            name: 'algorithm',
            type: 'varchar',
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'revoked_at',
            type: 'datetime',
            isNullable: true,
          },
          {
            name: 'is_active',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // Create indexes for audit_key_metadata
    await queryRunner.createIndex(
      'audit_key_metadata',
      new TableIndex({
        name: 'idx_audit_key_metadata_is_active',
        columnNames: ['is_active'],
      }),
    );

    await queryRunner.createIndex(
      'audit_key_metadata',
      new TableIndex({
        name: 'idx_audit_key_metadata_created',
        columnNames: ['created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.dropIndex('audit_key_metadata', 'idx_audit_key_metadata_created');
    await queryRunner.dropIndex('audit_key_metadata', 'idx_audit_key_metadata_is_active');
    await queryRunner.dropIndex(
      'audit_stream_checkpoints',
      'idx_audit_stream_checkpoints_stream_sequence',
    );
    await queryRunner.dropIndex(
      'audit_stream_records',
      'idx_audit_stream_records_stream_created',
    );
    await queryRunner.dropIndex(
      'audit_stream_records',
      'idx_audit_stream_records_stream_sequence',
    );

    // Drop tables
    await queryRunner.dropTable('audit_key_metadata');
    await queryRunner.dropTable('audit_stream_checkpoints');
    await queryRunner.dropTable('audit_stream_records');
  }
}
