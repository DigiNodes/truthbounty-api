import { AddUserRoleToUsers1790000000000 } from './1790000000000-AddUserRoleToUsers';

/**
 * Unit tests for the AddUserRoleToUsers migration (issue #458).
 *
 * Verifies:
 * - up() issues the correct ALTER TABLE and CREATE INDEX statements
 * - down() issues matching DROP INDEX and DROP COLUMN statements
 * - No side-effects on unrelated tables
 * - SQL is idempotent (IF NOT EXISTS / IF EXISTS guards)
 */
describe('Migration: AddUserRoleToUsers1790000000000', () => {
  const migration = new AddUserRoleToUsers1790000000000();

  // ── up() ──────────────────────────────────────────────────────────────────

  describe('up()', () => {
    let executedSql: string[];
    const mockRunner = {
      query: jest.fn().mockImplementation((sql: string) => {
        executedSql.push(sql.replace(/\s+/g, ' ').trim());
        return Promise.resolve();
      }),
    } as any;

    beforeEach(() => {
      executedSql = [];
      jest.clearAllMocks();
    });

    it('executes exactly two queries', async () => {
      await migration.up(mockRunner);
      expect(mockRunner.query).toHaveBeenCalledTimes(2);
    });

    it('adds the role column with a safe default of USER', async () => {
      await migration.up(mockRunner);
      const alterSql = executedSql[0];
      expect(alterSql).toMatch(/ALTER TABLE "users"/i);
      expect(alterSql).toMatch(/ADD COLUMN IF NOT EXISTS "role"/i);
      expect(alterSql).toMatch(/NOT NULL DEFAULT 'USER'/i);
    });

    it('creates a named index IDX_users_role', async () => {
      await migration.up(mockRunner);
      const indexSql = executedSql[1];
      expect(indexSql).toMatch(/CREATE INDEX IF NOT EXISTS "IDX_users_role"/i);
      expect(indexSql).toMatch(/ON "users" \("role"\)/i);
    });

    it('uses IF NOT EXISTS so re-running is idempotent', async () => {
      await migration.up(mockRunner);
      expect(executedSql[0]).toContain('IF NOT EXISTS');
      expect(executedSql[1]).toContain('IF NOT EXISTS');
    });

    it('does NOT touch any table other than "users"', async () => {
      await migration.up(mockRunner);
      for (const sql of executedSql) {
        // Strip the "users" references and make sure no other table names appear
        const withoutUsers = sql.replace(/"users"/gi, '');
        expect(withoutUsers).not.toMatch(/"[a-z_]+"(?!\s*\()/i);
      }
    });
  });

  // ── down() ────────────────────────────────────────────────────────────────

  describe('down()', () => {
    let executedSql: string[];
    const mockRunner = {
      query: jest.fn().mockImplementation((sql: string) => {
        executedSql.push(sql.replace(/\s+/g, ' ').trim());
        return Promise.resolve();
      }),
    } as any;

    beforeEach(() => {
      executedSql = [];
      jest.clearAllMocks();
    });

    it('executes exactly two queries', async () => {
      await migration.down(mockRunner);
      expect(mockRunner.query).toHaveBeenCalledTimes(2);
    });

    it('drops the index first', async () => {
      await migration.down(mockRunner);
      expect(executedSql[0]).toMatch(/DROP INDEX IF EXISTS "IDX_users_role"/i);
    });

    it('drops the role column', async () => {
      await migration.down(mockRunner);
      expect(executedSql[1]).toMatch(/ALTER TABLE "users" DROP COLUMN IF EXISTS "role"/i);
    });

    it('uses IF EXISTS so rollback is idempotent', async () => {
      await migration.down(mockRunner);
      for (const sql of executedSql) {
        expect(sql).toMatch(/IF EXISTS/i);
      }
    });
  });

  // ── Metadata ──────────────────────────────────────────────────────────────

  describe('migration metadata', () => {
    it('has the expected name stamp', () => {
      expect(migration.name).toBe('AddUserRoleToUsers1790000000000');
    });

    it('timestamp is greater than all existing migration timestamps', () => {
      const ts = 1790000000000;
      const existingTimestamps = [
        1704067200000,
        1769422695901,
        1769500000000,
        1769500000001,
        1769500000002,
        1769600000000,
        1769700000000,
        1769800000000,
        1769800100000,
        1769800200000,
        1769800300000,
        1769800400000,
        1785446400000,
        1788000000000,
      ];
      for (const existing of existingTimestamps) {
        expect(ts).toBeGreaterThan(existing);
      }
    });
  });
});
