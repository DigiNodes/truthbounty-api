import {
  parseRestoreDrillArgs,
  runRestoreDrill,
  RestoreDrillGuard,
} from './backup-restore-drill';

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
    ).rejects.toThrow('production-like target');

    await expect(
      runRestoreDrill({
        backupFile: 'backup.dump',
        targetDatabaseUrl: 'postgresql://db/drill',
        targetRedisUrl: 'redis://localhost:6379/1',
        productionRedisUrl: 'redis://localhost:6379/1',
      }),
    ).rejects.toThrow('production-like target');
  });

  it('rejects a drill targeting a non-empty target without confirmation token', async () => {
    const guard = new RestoreDrillGuard('secret-token');
    await expect(
      guard.validateTargets(
        'postgresql://db/drill',
        'redis://localhost:6379/1',
        undefined,
        undefined,
        'wrong-token',
      ),
    ).rejects.toThrow('confirmation token');
  });

  it('accepts a drill with a valid confirmation token on an isolated target', async () => {
    const guard = new RestoreDrillGuard('secret-token');
    const evidence = guard.validateTargets(
      'postgresql://db/drill',
      'redis://localhost:6379/1',
      undefined,
      undefined,
      'secret-token',
    );
    expect(evidence).toMatchObject({
      environmentClassification: 'isolation',
      credentialSeparation: 'redacted',
      confirmationTokenApplied: true,
      targetEmpty: false,
      targetDatabase: 'drill',
      targetScheme: 'postgresql',
    });
  });

  it('redacts credentials in the source URL evidence record', async () => {
    const guard = new RestoreDrillGuard('token-123');
    const evidence = guard.validateTargets(
      'postgresql://db/drill',
      'redis://localhost:6379/1',
      'postgresql://user:pass@host:5432/drill',
      'redis://user:pass@host:6379/1',
      'token-123',
    );
    expect(evidence.sourceUrlRedacted).toBe('postgres://drill');
    expect(evidence.targetScheme).toBe('postgresql');
    expect(evidence.targetDatabase).toBe('drill');
    expect(evidence.targetRedis).toBe('1');
  });

  it('rejects malformed database URLs', async () => {
    const guard = new RestoreDrillGuard('token-123');
    await expect(
      guard.validateTargets(
        'mysql://db/drill',
        'redis://localhost:6379/1',
        undefined,
        undefined,
        'token-123',
      ),
    ).rejects.toThrow('must use postgres or postgresql scheme');
  });

  it('rejects malformed Redis URLs', async () => {
    const guard = new RestoreDrillGuard('token-123');
    await expect(
      guard.validateTargets(
        'postgresql://db/drill',
        'redis-srv://localhost:6379/1',
        undefined,
        undefined,
        'token-123',
      ),
    ).rejects.toThrow('must use redis scheme');
  });

  it('restores, verifies connectivity, and invalidates the isolated cache', async () => {
    const commands: Array<[string, string[]]> = [];
    const redis = {
      flushdb: jest.fn().mockResolvedValue('OK'),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    await runRestoreDrill(
      {
        backupFile: 'backup.dump',
        targetDatabaseUrl: 'postgresql://db/drill',
        targetRedisUrl: 'redis://localhost:6379/1',
      },
      {
        fileAccess: jest.fn().mockResolvedValue(undefined),
        fileStat: jest.fn().mockResolvedValue({ isFile: () => true }),
        runCommand: jest.fn(async (command, args) => {
          commands.push([command, args]);
        }),
        connectRedis: jest.fn().mockResolvedValue(redis),
      },
    );

    expect(commands.map(([command]) => command)).toEqual([
      'pg_restore',
      'psql',
    ]);
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
