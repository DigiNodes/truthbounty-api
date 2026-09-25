import { parseRestoreDrillArgs, runRestoreDrill } from './backup-restore-drill';

describe('backup and restore drill', () => {
  it('requires an artifact and isolated database and Redis targets', () => {
    expect(() => parseRestoreDrillArgs([], {})).toThrow('Usage:');
  });

  it('rejects non-PostgreSQL targets before invoking restore tools', async () => {
    await expect(
      runRestoreDrill({
        backupFile: 'backup.dump',
        targetDatabaseUrl: 'sqlite://database.sqlite',
        targetRedisUrl: 'redis://localhost:6379/1',
      }),
    ).rejects.toThrow('PostgreSQL URL');
  });

  it('rejects production database and Redis targets', async () => {
    await expect(
      runRestoreDrill({
        backupFile: 'backup.dump',
        targetDatabaseUrl: 'postgresql://db/drill',
        targetRedisUrl: 'redis://localhost:6379/1',
        productionDatabaseUrl: 'postgresql://db/drill',
      }),
    ).rejects.toThrow('DATABASE_URL');

    await expect(
      runRestoreDrill({
        backupFile: 'backup.dump',
        targetDatabaseUrl: 'postgresql://db/drill',
        targetRedisUrl: 'redis://localhost:6379/1',
        productionRedisUrl: 'redis://localhost:6379/1',
      }),
    ).rejects.toThrow('REDIS_URL');
  });

  it('restores, verifies connectivity, and invalidates the isolated cache', async () => {
    const commands: Array<[string, string[]]> = [];
    const redis = { flushdb: jest.fn().mockResolvedValue('OK'), quit: jest.fn().mockResolvedValue('OK') };
    await runRestoreDrill(
      {
        backupFile: 'backup.dump',
        targetDatabaseUrl: 'postgresql://db/drill',
        targetRedisUrl: 'redis://localhost:6379/1',
      },
      {
        fileAccess: jest.fn().mockResolvedValue(undefined),
        fileStat: jest.fn().mockResolvedValue({ isFile: () => true }),
        runCommand: jest.fn(async (command, args) => commands.push([command, args])),
        connectRedis: jest.fn().mockResolvedValue(redis),
      },
    );

    expect(commands.map(([command]) => command)).toEqual(['pg_restore', 'psql']);
    expect(commands[0][1]).toContain('--exit-on-error');
    expect(redis.flushdb).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  it('does not touch Redis when PostgreSQL restore fails', async () => {
    const connectRedis = jest.fn();
    await expect(
      runRestoreDrill(
        {
          backupFile: 'backup.dump',
          targetDatabaseUrl: 'postgresql://db/drill',
          targetRedisUrl: 'redis://localhost:6379/1',
        },
        {
          fileAccess: jest.fn().mockResolvedValue(undefined),
          fileStat: jest.fn().mockResolvedValue({ isFile: () => true }),
          runCommand: jest.fn().mockRejectedValue(new Error('restore failed')),
          connectRedis,
        },
      ),
    ).rejects.toThrow('restore failed');
    expect(connectRedis).not.toHaveBeenCalled();
  });
});