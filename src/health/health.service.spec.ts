import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { RedisService } from '../redis/redis.service';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';

const mockDataSource = () => ({
  isInitialized: true,
  query: jest.fn(),
});

const mockRedisService = () => ({
  isHealthy: jest.fn(),
});

const mockQueue = () => ({
  getJobCounts: jest.fn(),
});

describe('HealthService', () => {
  let service: HealthService;
  let dataSource: DataSource;
  let redisService: RedisService;
  let queue: Queue;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DataSource, useFactory: mockDataSource },
        { provide: RedisService, useFactory: mockRedisService },
        { provide: 'BullQueue_jobs-queue', useFactory: mockQueue },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
    dataSource = module.get<DataSource>(DataSource);
    redisService = module.get<RedisService>(RedisService);
    queue = module.get<Queue>('BullQueue_jobs-queue');
  });

  it('should return alive liveness result', () => {
    const result = service.getLiveness();
    expect(result.status).toBe('alive');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should report healthy readiness when all checks pass', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);
    (redisService.isHealthy as jest.Mock).mockResolvedValue(true);
    (queue.getJobCounts as jest.Mock).mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });

    const result = await service.getReadiness();
    expect(result.ready).toBe(true);
    expect(result.status).toBe('healthy');
    expect(result.dependencies).toHaveLength(3);
  });

  it('should report unhealthy when database is down', async () => {
    (dataSource.query as jest.Mock).mockRejectedValue(new Error('DB timeout'));
    (redisService.isHealthy as jest.Mock).mockResolvedValue(true);
    (queue.getJobCounts as jest.Mock).mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });

    const result = await service.getReadiness();
    expect(result.ready).toBe(false);
    expect(result.status).toBe('unhealthy');
  });

  it('should report degraded when redis is down but db and queue are up', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);
    (redisService.isHealthy as jest.Mock).mockResolvedValue(false);
    (queue.getJobCounts as jest.Mock).mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });

    const result = await service.getReadiness();
    expect(result.ready).toBe(true);
    expect(result.status).toBe('degraded');
  });

  it('should include health metadata and dependency summary', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);
    (redisService.isHealthy as jest.Mock).mockResolvedValue(true);
    (queue.getJobCounts as jest.Mock).mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });

    const result = await service.getHealth();

    expect(result.environment).toBe(process.env.NODE_ENV ?? 'development');
    expect(result.summary).toEqual(
      expect.objectContaining({
        healthy: expect.any(Number),
        degraded: expect.any(Number),
        unhealthy: expect.any(Number),
      }),
    );
    expect(result.dependencies.some((dep) => dep.name === 'database')).toBe(true);
  });

  it('should return not ready while shutting down', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);
    (redisService.isHealthy as jest.Mock).mockResolvedValue(true);
    (queue.getJobCounts as jest.Mock).mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });

    (service as unknown as { shuttingDown: boolean }).shuttingDown = true;

    const result = await service.getReadiness();
    expect(result.ready).toBe(false);
    expect(result.status).toBe('unhealthy');
  });
});
