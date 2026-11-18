jest.mock('./runtime-config', () => ({
  getRuntimeEnvironment: () => ({}),
}));

import { buildDataSourceOptions } from './data-source';

describe('TypeORM CLI datasource', () => {
  it('uses PostgreSQL as the only supported persistence engine', () => {
    const options = buildDataSourceOptions({} as NodeJS.ProcessEnv);

    expect(options).toMatchObject({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      database: 'truthbounty',
      synchronize: false,
      migrations: ['src/migrations/*.ts'],
    });
    expect(options).not.toHaveProperty('database', 'database.sqlite');
  });

  it('uses DATABASE_URL when supplied', () => {
    const options = buildDataSourceOptions({
      DATABASE_URL: 'postgresql://user:password@db.example.test:5432/truthbounty',
      DB_SSL: 'true',
    } as NodeJS.ProcessEnv);

    expect(options).toMatchObject({
      type: 'postgres',
      url: 'postgresql://user:password@db.example.test:5432/truthbounty',
      ssl: { rejectUnauthorized: true },
      synchronize: false,
      migrations: ['src/migrations/*.ts'],
    });
  });

  it('rejects an invalid PostgreSQL port', () => {
    expect(() =>
      buildDataSourceOptions({ DB_PORT: '70000' } as NodeJS.ProcessEnv),
    ).toThrow('DB_PORT must be an integer between 1 and 65535');
  });
});
