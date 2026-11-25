import { PersistUserThemePreferences1793200000000 } from './1793200000000-PersistUserThemePreferences';

describe('Migration: PersistUserThemePreferences1793200000000', () => {
  const migration = new PersistUserThemePreferences1793200000000();

  const createRunner = () => {
    const query = jest.fn().mockResolvedValue(undefined);
    return {
      query,
      connection: { options: { type: 'postgres' } },
    } as any;
  };

  it('creates an owner-scoped table with a theme check constraint', async () => {
    const runner = createRunner();

    await migration.up(runner);

    expect(runner.query).toHaveBeenCalledTimes(2);
    expect(runner.query.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS "user_theme_preferences"');
    expect(runner.query.mock.calls[0][0]).toContain('"userId" varchar(255) NOT NULL');
    expect(runner.query.mock.calls[0][0]).toContain(
      'CHECK ("theme" IN (\'light\',\'dark\',\'system\'))',
    );
  });

  it('creates a unique index per owner', async () => {
    const runner = createRunner();

    await migration.up(runner);

    expect(runner.query.mock.calls[1][0]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(runner.query.mock.calls[1][0]).toContain('("userId")');
  });

  it('rejects non-postgres connections', async () => {
    const runner = createRunner();
    runner.connection.options.type = 'sqlite';

    await expect(migration.up(runner)).rejects.toThrow(
      'Theme preference persistence requires PostgreSQL',
    );
  });

  it('drops the preference table on rollback', async () => {
    const runner = createRunner();

    await migration.down(runner);

    expect(runner.query).toHaveBeenCalledWith(
      'DROP TABLE IF EXISTS "user_theme_preferences"',
    );
  });
});
