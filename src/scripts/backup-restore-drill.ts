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
  connectRedis?: (url: string) => Promise<{ flushdb: () => Promise<string>; quit: () => Promise<string> }>;
  fileAccess?: typeof access;
  fileStat?: typeof stat;
}

export function parseRestoreDrillArgs(args: string[], env = process.env): RestoreDrillOptions {
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
  const targetDatabaseUrl = values.get('target-url') ?? env.RESTORE_DRILL_DATABASE_URL;
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

export async function runRestoreDrill(
  options: RestoreDrillOptions,
  dependencies: RestoreDrillDependencies = {},
): Promise<void> {
  assertIsPostgresUrl('target-url', options.targetDatabaseUrl);
  if (options.productionDatabaseUrl && options.targetDatabaseUrl === options.productionDatabaseUrl) {
    throw new Error('Refusing to restore into DATABASE_URL; provide an isolated drill database');
  }
  if (options.productionRedisUrl && options.targetRedisUrl === options.productionRedisUrl) {
    throw new Error('Refusing to flush REDIS_URL; provide an isolated drill Redis instance');
  }

  const fileAccess = dependencies.fileAccess ?? access;
  const fileStat = dependencies.fileStat ?? stat;
  await fileAccess(options.backupFile, constants.R_OK);
  if (!(await fileStat(options.backupFile)).isFile()) {
    throw new Error(`Backup artifact is not a regular file: ${options.backupFile}`);
  }

  const runCommand = dependencies.runCommand ?? (async (command, args) => {
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

  const connectRedis = dependencies.connectRedis ?? (async (url: string) => {
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
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
  console.log('Restore drill completed: PostgreSQL restored and isolated Redis cache invalidated.');
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`Restore drill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}