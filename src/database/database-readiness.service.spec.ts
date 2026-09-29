import { DatabaseReadinessService } from './database-readiness.service';
import { DataSource } from 'typeorm';

describe('DatabaseReadinessService', () => {
  let service: DatabaseReadinessService;
  let mockDataSource: Partial<DataSource>;

  beforeEach(() => {
    mockDataSource = {
      isInitialized: true,
      query: jest.fn(),
      showMigrations: jest.fn(),
    };
    service = new DatabaseReadinessService(mockDataSource as DataSource);
  });

  it('reports HEALTHY and ready when database is connected, no pending migrations, and schema v2 matches', async () => {
    (mockDataSource.query as jest.Mock)
      .mockResolvedValueOnce([{ '?column?': 1 }]) // SELECT 1
      .mockResolvedValueOnce([{ exists: true }]) // v2_schema_versions exists
      .mockResolvedValueOnce([{ current_version: '2' }]); // MAX(version) = 2
    (mockDataSource.showMigrations as jest.Mock).mockResolvedValueOnce(false); // No pending migrations

    const report = await service.checkReadiness();

    expect(report.ready).toBe(true);
    expect(report.status).toBe('HEALTHY');
    expect(report.hasPendingMigrations).toBe(false);
    expect(report.schemaVersion).toBe(2);
    expect(report.failureReason).toBeUndefined();
  });

  it('fails closed when dataSource is not initialized', async () => {
    mockDataSource.isInitialized = false;

    const report = await service.checkReadiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('UNHEALTHY');
    expect(report.failureReason).toContain('not initialized');
  });

  it('fails closed when pending migrations are detected', async () => {
    (mockDataSource.query as jest.Mock).mockResolvedValueOnce([{ '?column?': 1 }]);
    (mockDataSource.showMigrations as jest.Mock).mockResolvedValueOnce(true); // Pending migrations exist!

    const report = await service.checkReadiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('UNHEALTHY');
    expect(report.hasPendingMigrations).toBe(true);
    expect(report.failureReason).toContain('Pending database migrations detected');
  });

  it('fails closed when v2_schema_versions table is missing', async () => {
    (mockDataSource.query as jest.Mock)
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ exists: false }]); // table missing
    (mockDataSource.showMigrations as jest.Mock).mockResolvedValueOnce(false);

    const report = await service.checkReadiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('UNHEALTHY');
    expect(report.failureReason).toContain('v2_schema_versions table is missing');
  });

  it('fails closed when schema version does not match V2 baseline', async () => {
    (mockDataSource.query as jest.Mock)
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([{ current_version: '1' }]); // version 1 instead of 2
    (mockDataSource.showMigrations as jest.Mock).mockResolvedValueOnce(false);

    const report = await service.checkReadiness();

    expect(report.ready).toBe(false);
    expect(report.status).toBe('UNHEALTHY');
    expect(report.schemaVersion).toBe(1);
    expect(report.failureReason).toContain('Incompatible schema version');
  });

  it('sanitizes credentials from error messages', () => {
    const sensitiveError =
      'Connection error at postgres://truthbounty:supersecretpassword@localhost:5432/truthdb password=supersecretpassword';
    const sanitized = service.sanitizeErrorMessage(sensitiveError);

    expect(sanitized).not.toContain('supersecretpassword');
    expect(sanitized).toContain('password=***');
    expect(sanitized).toContain('postgres://***:***@');
  });
});
