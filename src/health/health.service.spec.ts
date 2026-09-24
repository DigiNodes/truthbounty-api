import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { RedisService } from '../redis/redis.service';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { JobsService } from '../jobs/jobs.service';
import { NotificationService } from '../notifications/services/notification.service';
import { IpfsService } from '../ipfs/ipfs.service';
import { BlockchainStateService } from '../blockchain/state.service';
import { MetricsService } from '../metrics/metrics.service';

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

const mockJobsService = () => ({
  getQueueMetrics: jest.fn(),
});

const mockNotificationService = () => ({
  getMetrics: jest.fn(),
});

const mockIpfsService = () => ({
  uploadBuffer: jest.fn(),
});

const mockBlockchainStateService = () => ({
  getChainState: jest.fn().mockResolvedValue({ lastProcessedBlock: 123 }),
  getIndexerHealth: jest.fn().mockResolvedValue({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    observedHeadBlock: 100,
    safeBlock: 88,
    finalizedBlock: 80,
    projectionHeadBlock: 80,
    projectionLag: 20,
    rpcFailureCount: 0,
    replayCount: 0,
    deadLetterCount: 0,
    alertThresholds: {
      projectionLagBlocks: 150,
      rpcFailureRateWindow: 300000,
      maxDeadLetters: 100,
    },
    runbookUrl:
      'https://github.com/DigiNodes/truthbounty-api/blob/main/docs/indexer-runbook.md',
  }),
});

const mockMetricsService = () => ({
  setMemoryUsage: jest.fn(),
  setCpuUsage: jest.fn(),
  setQueueDepth: jest.fn(),
  setBlockchainIndexingState: jest.fn(),
});

describe('HealthService', () => {
  let service: HealthService;
  let dataSource: DataSource;
  let redisService: RedisService;
  let queue: Queue;
  let jobsService: JobsService;
  let notificationService: NotificationService;
  let ipfsService: IpfsService;
  let blockchainStateService: BlockchainStateService;
  let metricsService: MetricsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DataSource, useFactory: mockDataSource },
        { provide: RedisService, useFactory: mockRedisService },
        { provide: 'BullQueue_jobs-queue', useFactory: mockQueue },
        { provide: JobsService, useFactory: mockJobsService },
        { provide: NotificationService, useFactory: mockNotificationService },
        { provide: IpfsService, useFactory: mockIpfsService },
 feat/be-016-monitoring-api
        { provide: BlockchainStateService, useFactory: mockBlockchainStateService },
        { provide: MetricsService, useFactory: mockMetricsService },
        {
          provide: BlockchainStateService,
          useFactory: mockBlockchainStateService,
        },
 main
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
    dataSource = module.get<DataSource>(DataSource);
    redisService = module.get<RedisService>(RedisService);
    queue = module.get<Queue>('BullQueue_jobs-queue');
    jobsService = module.get<JobsService>(JobsService);
    notificationService = module.get<NotificationService>(NotificationService);
    ipfsService = module.get<IpfsService>(IpfsService);
 feat/be-016-monitoring-api
    blockchainStateService = module.get<BlockchainStateService>(BlockchainStateService);
    metricsService = module.get<MetricsService>(MetricsService);
    blockchainStateService = module.get<BlockchainStateService>(
      BlockchainStateService,
    );
 main
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
    expect(result.dependencies.some((dep) => dep.name === 'database')).toBe(
      true,
    );
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

  it('should expose an indexer health report that is sanitized', async () => {
    const result = await service.getIndexerHealth();

    expect(result.status).toBe('healthy');
    expect(result.snapshot).toMatchObject({
      observedHeadBlock: 100,
      safeBlock: 88,
      finalizedBlock: 80,
      projectionLag: 20,
      replayCount: 0,
      deadLetterCount: 0,
    });
    expect(result.snapshot.alertThresholds.projectionLagBlocks).toBeGreaterThan(
      0,
    );
    expect(result.snapshot.runbookUrl).toBeTruthy();
  });
});
