import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Provisions an isolated, throwaway Prisma/SQLite database for e2e tests via
 * `prisma db push` (schema-driven sync), and points DATABASE_URL at it
 * before the Nest app boots.
 *
 * Deliberately does NOT touch the repo's shared dev.db or its migration
 * history: dev.db predates a `walletAddress` column that schema.prisma has
 * required (`@unique`) since the initial migration, but no migration ever
 * added it — a pre-existing drift unrelated to this feature. `db push`
 * bypasses migration history entirely and creates tables straight from the
 * current schema, so it's unaffected by that gap.
 */
export function setupPrismaTestDatabase(testName: string): { databaseUrl: string; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `truthbounty-ai-e2e-${testName}-${Date.now()}.db`);
  const databaseUrl = `file:${dbPath}`;

  execSync(`npx prisma db push --url="${databaseUrl}" --accept-data-loss`, {
    cwd: path.join(__dirname, '..', '..'),
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;

  return {
    databaseUrl,
    cleanup: () => {
      // Best-effort: the SQLite file handle may still be closing when the
      // Nest app shuts down, so a lingering lock here isn't worth failing
      // the suite over — these are throwaway files in the OS temp dir.
      for (const ext of ['', '-journal', '-wal', '-shm']) {
        const file = `${dbPath}${ext}`;
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
    },
  };
}
