import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  let service: DashboardService;
  let adminRepo: any;
  let incidentRepo: any;
  let reportRepo: any;
  let auditLogRepo: any;
  let jobsService: any;
  let notificationService: any;
  let redisService: any;
  let metricsService: any;

  beforeEach(() => {
    adminRepo = {
      count: jest.fn(),
      query: jest.fn(),
    };
    incidentRepo = {
      count: jest.fn(),
      find: jest.fn(),
    };
    reportRepo = {
      count: jest.fn(),
      find: jest.fn(),
    };
    auditLogRepo = {
      createQueryBuilder: jest.fn(),
    };
    jobsService = {
      getAllQueueMetrics: jest.fn(),
    };
    notificationService = {
      getMetrics: jest.fn(),
    };
    redisService = {
      isHealthy: jest.fn(),
      getStatus: jest.fn(),
    };
    metricsService = {
      getSummary: jest.fn(),
    };

    service = new DashboardService(
      adminRepo,
      incidentRepo,
      reportRepo,
      auditLogRepo,
      jobsService,
      notificationService,
      redisService,
      metricsService,
    );
  });

  it('should aggregate operational summary data from backend services', async () => {
    adminRepo.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    incidentRepo.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    reportRepo.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    reportRepo.find.mockResolvedValue([{ createdAt: new Date(), resolvedAt: new Date() }]);
    jobsService.getAllQueueMetrics.mockResolvedValue([
      { name: 'default', waiting: 2, active: 1, completed: 10, failed: 0, delayed: 1, paused: false },
    ]);
    notificationService.getMetrics.mockResolvedValue({ queued: 5, delivered: 4, failed: 1, queueDepth: 2 });
    redisService.isHealthy.mockResolvedValue(true);
    redisService.getStatus.mockReturnValue({ connected: true, enabled: true });
    metricsService.getSummary.mockResolvedValue({ totalRequests: 120, errorCount: 3, averageLatencyMs: 40 });

    const summary = await service.getOperationalSummary();

    expect(summary.system.status).toBe('healthy');
    expect(summary.infrastructure.database.status).toBe('healthy');
    expect(summary.queues.totalWaiting).toBe(2);
    expect(summary.notifications.delivered).toBe(4);
    expect(summary.api.totalRequests).toBe(120);
    expect(summary.protocol.activeClaims).toBe(3);
  });
});
