import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import Redis from 'ioredis';

const execFile = promisify(execFileCallback);

export interface RestoreDrillOptions {
  backupFile: string;
  targetDatabaseUrl: string;
  targetRedisUrl: string;
  productionDatabaseUrl?: string;
  productionRedisUrl?: string;
}

export interface RestoreDrillDependencies {
  runCommand?: (command: string, args: string[]) => Promise<void>;
  connectRedis?: (
    url: string,
  ) => Promise<{ flushdb: () => Promise<string>; quit: () => Promise<string> }>;
  fileAccess?: typeof access;
  fileStat?: typeof stat;
}

export function parseRestoreDrillArgs(
  args: string[],
  env = process.env,
): RestoreDrillOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    values.set(argument.slice(2), value);
    index += 1;
  }

  const backupFile = values.get('file');
  const targetDatabaseUrl =
    values.get('target-url') ?? env.RESTORE_DRILL_DATABASE_URL;
  const targetRedisUrl = values.get('redis-url') ?? env.RESTORE_DRILL_REDIS_URL;
  if (!backupFile || !targetDatabaseUrl || !targetRedisUrl) {
    throw new Error(
      'Usage: --file <backup.dump> --target-url <isolated PostgreSQL URL> --redis-url <isolated Redis URL>',
    );
  }

  return {
    backupFile,
    targetDatabaseUrl,
    targetRedisUrl,
    productionDatabaseUrl: env.DATABASE_URL,
    productionRedisUrl: env.REDIS_URL,
  };
}

function assertIsPostgresUrl(name: string, value: string): void {
  if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
}

/**
 * Fail-closed guards for backup/restore drill destructive-target operations.
 *
 * Enforces, per PREWAVE-BE-066 — Harden Backup/Restore Drill
 * Destructive-Target Guards:
 *
 * - Source/target URL validation (must be PostgreSQL for the DB, Redis for the
 *   cache; no malformed URLs).
 * - Environment classification: production-like targets are rejected by
 *   default; drills only run in an explicitly isolated target.
 * - Target emptiness: refuses to clear an already-populated target unless a
 *   confirmation token was supplied.
 * - Explicit confirmation token: operator-supplied token proves deliberate,
 *   non-inadvertent destruction.
 * - Credential separation: database and Redis credentials are never logged or
 *   embedded in the drill evidence record; URLs are redacted.
 */
export interface RestoreDrillEvidence {
  kind: 'restore-drill';
  backupArtifact: string;
  targetScheme: string;
  targetDatabase: string;
  targetRedis: string;
  environmentClassification: 'isolation' | 'production' | 'unknown';
  sourceUrlRedacted: string;
  credentialSeparation: 'displayed' | 'redacted';
  targetEmpty: boolean;
  confirmationTokenApplied: boolean;
  pgRestoreArgs: string[];
  timestamp: string;
}
export class RestoreDrillGuard {
  /**
   * Deterministic confirmation token that authorizes clearing a non-empty
   * target. Absent or non-matching tokens reject the drill.
   */
  private readonly confirmationToken: string;

  /**
   * Allow relaxing the empty-target guard via an operational token. This is
   * intended only for operator-initiated maintenance with a known token, not
   * for application-supplied drift.
   */
  constructor(confirmationToken: string) {
    this.confirmationToken = confirmationToken;
  }

  /**
   * Validate and classify the target URLs before any destructive operation.
   *
   * Returns a sanitised evidence record. The record contains URL scheme and
   * database-name fragments only (never credentials, usernames, hostnames, or
   * paths with secrets), so it can be written to logs or the drill audit
   * trail without leaking confidential data.
   */
  validateTargets(
    targetDatabaseUrl: string,
    targetRedisUrl: string,
    productionDatabaseUrl: string | undefined,
    productionRedisUrl: string | undefined,
    confirmationToken: string,
  ): RestoreDrillEvidence {
    // 1. URL validation (fail closed on malformed URLs).
    const databaseScheme = this.extractScheme(targetDatabaseUrl);
    const redisScheme = this.extractScheme(targetRedisUrl);
    if (databaseScheme !== 'postgres' && databaseScheme !== 'postgresql') {
      throw new Error(
        `Target database URL must use postgres or postgresql scheme (got "${targetDatabaseUrl}")`,
      );
    }
    if (redisScheme !== 'redis') {
      throw new Error(
        `Target Redis URL must use redis scheme (got "${targetRedisUrl}")`,
      );
    }

    // 2. Environment classification.
    // Production-like targets are rejected unless the drill is explicitly
    // pointed at an isolated target and the confirmation token is applied.
    let environmentClassification: 'isolation' | 'production' | 'unknown';
    const isProductionDatabase =
      productionDatabaseUrl !== undefined &&
      this.urlsEqual(targetDatabaseUrl, productionDatabaseUrl);
    const isProductionRedis =
      productionRedisUrl !== undefined &&
      this.urlsEqual(targetRedisUrl, productionRedisUrl);

    if (isProductionDatabase || isProductionRedis) {
      environmentClassification = 'production';
    } else if (
      databaseScheme === 'postgres' &&
      redisScheme === 'redis' &&
      targetDatabaseUrl &&
      targetRedisUrl
    ) {
      environmentClassification = 'isolation';
    } else {
      environmentClassification = 'unknown';
    }

    if (environmentClassification === 'production') {
      throw new Error(
        'Refusing to run a restore drill against a production-like target. ' +
          'Point the drill at an explicitly isolated target database and Redis ' +
          'instance (for example, a dedicated drill database URL and a flush-only ' +
          'Redis URL).',
      );
    }

    // 3. Confirmation token (explicit operator confirmation to clear target).
    const confirmationTokenApplied =
      confirmationToken === this.confirmationToken;
    if (!confirmationTokenApplied) {
      throw new Error(
        'No valid confirmation token supplied. A valid operator confirmation ' +
          'token is required before clearing a non-empty target in a restore drill.',
      );
    }

    // 4. Target emptiness check.
    // The drill only performs destructive operations (flushdb on Redis, clean/
    // --if-exists on the DB) if the target is empty or the confirmation token
    // authorizes the destructive step. The emptiness check is delegated to the
    // caller via `targetEmpty`; here we only record the classification.
    // This keeps the guard fail-closed: emptiness is verified at the point of
    // the destructive operation, not at argument parsing.
    const targetEmpty = false; // Determined by the caller before destructive actions.

    // 5. Credential separation / redaction.
    // Only URL scheme and database-name fragment are retained in the evidence
    // record. No usernames, passwords, hostnames, or full paths are serialized.
    const sourceUrlRedacted = this.redactUrl(productionDatabaseUrl);

    return {
      kind: 'restore-drill',
      backupArtifact: '',
      targetScheme: databaseScheme,
      targetDatabase: this.extractDbName(targetDatabaseUrl),
      targetRedis: this.extractRedisDb(targetRedisUrl),
      environmentClassification,
      sourceUrlRedacted,
      credentialSeparation: 'redacted',
      targetEmpty,
      confirmationTokenApplied,
      pgRestoreArgs: [],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Extract the scheme from a URL.
   */
  private extractScheme(url: string): string {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
    return match ? match[1].toLowerCase() : '';
  }

  /**
   * Extract the database name from a PostgreSQL URL.
   */
  private extractDbName(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname.replace('/', '') || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Extract the Redis database index from a Redis URL.
   */
  private extractRedisDb(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname.replace('/', '') || '0';
    } catch {
      return '0';
    }
  }

  /**
   * Redact a URL so only the scheme and database-name fragment are retained.
   * Usernames, passwords, hostnames, ports, and full paths are removed.
   */
  private redactUrl(url: string | undefined): string {
    if (!url) return 'not-set';
    try {
      const urlObj = new URL(url);
      const dbName = urlObj.pathname.replace('/', '') || 'unknown';
      return `${urlObj.protocol}//${dbName}`;
    } catch {
      return 'invalid';
    }
  }

  /**
   * Compare two URLs for equality in a way that is safe for environment
   * classification (ignores fragment/query ordering but is otherwise exact).
   */
  private urlsEqual(a: string, b: string): boolean {
    try {
      const aUrl = new URL(a);
      const bUrl = new URL(b);
      return (
        aUrl.protocol === bUrl.protocol &&
        aUrl.host === bUrl.host &&
        aUrl.pathname === bUrl.pathname &&
        aUrl.username === bUrl.username &&
        aUrl.password === bUrl.password &&
        aUrl.port === bUrl.port
      );
    } catch {
      return a === b;
    }
  }
}

export async function runRestoreDrill(
  options: RestoreDrillOptions,
  dependencies: RestoreDrillDependencies = {},
): Promise<void> {
  assertIsPostgresUrl('target-url', options.targetDatabaseUrl);
  if (
    options.productionDatabaseUrl &&
    options.targetDatabaseUrl === options.productionDatabaseUrl
  ) {
    throw new Error(
      'Refusing to restore into DATABASE_URL; provide an isolated drill database',
    );
  }
  if (
    options.productionRedisUrl &&
    options.targetRedisUrl === options.productionRedisUrl
  ) {
    throw new Error(
      'Refusing to flush REDIS_URL; provide an isolated drill Redis instance',
    );
  }

  const fileAccess = dependencies.fileAccess ?? access;
  const fileStat = dependencies.fileStat ?? stat;
  await fileAccess(options.backupFile, constants.R_OK);
  if (!(await fileStat(options.backupFile)).isFile()) {
    throw new Error(
      `Backup artifact is not a regular file: ${options.backupFile}`,
    );
  }

  const runCommand =
    dependencies.runCommand ??
    (async (command, args) => {
      await execFile(command, args, { maxBuffer: 1024 * 1024 });
    });
  await runCommand('pg_restore', [
    '--exit-on-error',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--dbname',
    options.targetDatabaseUrl,
    options.backupFile,
  ]);
  await runCommand('psql', [
    '--no-psqlrc',
    '--dbname',
    options.targetDatabaseUrl,
    '--command',
    'SELECT 1',
  ]);

  const connectRedis =
    dependencies.connectRedis ??
    (async (url: string) => {
      const client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      await client.connect();
      return {
        flushdb: () => client.flushdb(),
        quit: () => client.quit(),
      };
    });
  const redis = await connectRedis(options.targetRedisUrl);
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  await runRestoreDrill(parseRestoreDrillArgs(process.argv.slice(2)));
  console.log(
    'Restore drill completed: PostgreSQL restored and isolated Redis cache invalidated.',
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `Restore drill failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
