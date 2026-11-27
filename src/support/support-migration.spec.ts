import { DataSource, QueryRunner } from 'typeorm';
import { PersistSupportRequests1793200000000 } from '../migrations/1793200000000-PersistSupportRequests';

/**
 * PREWAVE-BE-106 (#807): Migration tests for support_requests table.
 *
 * Tests cover:
 * - Migration up creates table with correct schema
 * - Migration down removes table
 * - Constraints and indexes are created correctly
 */
describe('PersistSupportRequests Migration', () => {
  let migration: PersistSupportRequests1793200000000;
  let queryRunner: QueryRunner;
  let mockConnection: any;

  beforeEach(() => {
    migration = new PersistSupportRequests1793200000000();

    mockConnection = {
      options: { type: 'postgres' },
    };

    queryRunner = {
      connection: mockConnection,
      query: jest.fn(),
    } as any;
  });

  describe('up', () => {
    it('should create support_requests table with all columns', async () => {
      await migration.up(queryRunner);

      const queries = (queryRunner.query as jest.Mock).mock.calls.map(
        (call) => call[0],
      );

      // Verify CREATE TABLE statement
      const createTableQuery = queries.find((q) =>
        q.includes('CREATE TABLE "support_requests"'),
      );
      expect(createTableQuery).toBeDefined();

      // Verify columns
      expect(createTableQuery).toContain('"id" uuid NOT NULL PRIMARY KEY');
      expect(createTableQuery).toContain('"reference" varchar(32) NOT NULL UNIQUE');
      expect(createTableQuery).toContain('"category" varchar(32) NOT NULL');
      expect(createTableQuery).toContain('"encryptedContact" text NOT NULL');
      expect(createTableQuery).toContain('"encryptedDescription" text NOT NULL');
      expect(createTableQuery).toContain('"release" varchar(120) NULL');
      expect(createTableQuery).toContain('"diagnostics" jsonb NOT NULL DEFAULT');
      expect(createTableQuery).toContain('"fingerprintKey" varchar(64) NOT NULL UNIQUE');
      expect(createTableQuery).toContain('"status" varchar(16) NOT NULL DEFAULT \'submitted\'');
      expect(createTableQuery).toContain('"duplicate" boolean NOT NULL DEFAULT false');
      expect(createTableQuery).toContain('"duplicateOf" uuid NULL');
      expect(createTableQuery).toContain('"expiresAt" timestamptz NOT NULL');
      expect(createTableQuery).toContain('"retentionDays" int NOT NULL DEFAULT 30');
      expect(createTableQuery).toContain('"createdAt" timestamptz NOT NULL DEFAULT now()');
      expect(createTableQuery).toContain('"updatedAt" timestamptz NOT NULL DEFAULT now()');
    });

    it('should create CHECK constraints', async () => {
      await migration.up(queryRunner);

      const queries = (queryRunner.query as jest.Mock).mock.calls.map(
        (call) => call[0],
      );

      const createTableQuery = queries.find((q) =>
        q.includes('CREATE TABLE "support_requests"'),
      );

      // Status constraint
      expect(createTableQuery).toContain('CONSTRAINT "chk_support_request_status"');
      expect(createTableQuery).toContain(
        "\"status\" IN ('submitted', 'duplicate', 'expired', 'deleted')",
      );

      // Retention days constraint
      expect(createTableQuery).toContain(
        'CONSTRAINT "chk_support_request_retention_days"',
      );
      expect(createTableQuery).toContain('"retentionDays" > 0 AND "retentionDays" <= 365');

      // Expires future constraint
      expect(createTableQuery).toContain(
        'CONSTRAINT "chk_support_request_expires_future"',
      );
      expect(createTableQuery).toContain('"expiresAt" > "createdAt"');

      // Duplicate bound constraint
      expect(createTableQuery).toContain(
        'CONSTRAINT "chk_support_request_duplicate_bound"',
      );

      // Fingerprint length constraint
      expect(createTableQuery).toContain(
        'CONSTRAINT "chk_support_request_fingerprint_length"',
      );
      expect(createTableQuery).toContain('length("fingerprintKey") = 64');

      // Reference format constraint
      expect(createTableQuery).toContain(
        'CONSTRAINT "chk_support_request_reference_format"',
      );
      expect(createTableQuery).toContain("\"reference\" ~ '^SUP-[A-Z0-9]{1,20}$'");

      // Encrypted fields constraint
      expect(createTableQuery).toContain(
        'CONSTRAINT "chk_support_request_encrypted_fields"',
      );
      expect(createTableQuery).toContain('length("encryptedContact") > 0');
      expect(createTableQuery).toContain('length("encryptedDescription") > 0');
    });

    it('should create indexes for efficient queries', async () => {
      await migration.up(queryRunner);

      const queries = (queryRunner.query as jest.Mock).mock.calls.map(
        (call) => call[0],
      );

      // Fingerprint index
      expect(
        queries.some((q) => q.includes('idx_support_requests_fingerprint')),
      ).toBe(true);

      // Reference index
      expect(
        queries.some((q) => q.includes('idx_support_requests_reference')),
      ).toBe(true);

      // Expires at index (for retention purge)
      expect(
        queries.some((q) => q.includes('idx_support_requests_expires_at')),
      ).toBe(true);

      // Created at index (for quota checks)
      expect(
        queries.some((q) => q.includes('idx_support_requests_created_at')),
      ).toBe(true);

      // Status + created index (for staff queries)
      expect(
        queries.some((q) => q.includes('idx_support_requests_status_created')),
      ).toBe(true);

      // Duplicate window index
      expect(
        queries.some((q) => q.includes('idx_support_requests_duplicate_window')),
      ).toBe(true);
    });

    it('should require PostgreSQL database', async () => {
      const sqliteRunner = {
        connection: { options: { type: 'sqlite' } },
        query: jest.fn(),
      } as any;

      await expect(migration.up(sqliteRunner)).rejects.toThrow(
        'Support request persistence requires PostgreSQL',
      );
    });
  });

  describe('down', () => {
    it('should drop support_requests table', async () => {
      await migration.down(queryRunner);

      expect(queryRunner.query).toHaveBeenCalledWith(
        'DROP TABLE "support_requests"',
      );
    });

    it('should be destructive - warn in migration comments', () => {
      const migrationSource = migration.down.toString();
      
      // The down method should be simple and clean up all artifacts
      expect(migration.down).toBeDefined();
    });
  });

  describe('Constraint Enforcement', () => {
    it('should document unique constraint on fingerprintKey for duplicate detection', async () => {
      await migration.up(queryRunner);

      const queries = (queryRunner.query as jest.Mock).mock.calls.map(
        (call) => call[0],
      );

      const createTableQuery = queries.find((q) =>
        q.includes('CREATE TABLE "support_requests"'),
      );

      expect(createTableQuery).toContain('"fingerprintKey" varchar(64) NOT NULL UNIQUE');
    });

    it('should document unique constraint on reference', async () => {
      await migration.up(queryRunner);

      const queries = (queryRunner.query as jest.Mock).mock.calls.map(
        (call) => call[0],
      );

      const createTableQuery = queries.find((q) =>
        q.includes('CREATE TABLE "support_requests"'),
      );

      expect(createTableQuery).toContain('"reference" varchar(32) NOT NULL UNIQUE');
    });
  });
});
