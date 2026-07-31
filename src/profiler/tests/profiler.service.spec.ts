import { Test, TestingModule } from '@nestjs/testing';
import { ProfilerService } from '../profiler.service';

describe('ProfilerService', () => {
  let service: ProfilerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProfilerService],
    }).compile();

    service = module.get<ProfilerService>(ProfilerService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Traces & Spans', () => {
    it('should start and end a trace successfully', () => {
      const trace = service.startTrace('HTTP GET /api/v1/claims', 'http', { route: '/api/v1/claims' });
      expect(trace).toBeDefined();
      expect(trace.id).toBeDefined();
      expect(trace.rootSpan.name).toEqual('HTTP GET /api/v1/claims');

      const endedTrace = service.endTrace(trace.id, { statusCode: 200 });
      expect(endedTrace).not.toBeNull();
      expect(endedTrace!.durationMs).toBeGreaterThanOrEqual(0);
      expect(endedTrace!.statusCode).toEqual(200);
    });

    it('should track sub-spans linked to an active trace context', () => {
      const trace = service.startTrace('HTTP POST /claims', 'http', { route: '/claims' });

      const dbSpan = service.startSpan('DB:claims', 'db', undefined, { query: 'SELECT * FROM claim' });
      expect(dbSpan.traceId).toEqual(trace.id);
      expect(dbSpan.parentSpanId).toEqual(trace.rootSpan.id);

      service.endSpan(dbSpan.id, 'ok', { durationMs: 15 });
      service.endTrace(trace.id, { statusCode: 201 });

      const retrieved = service.getTraceById(trace.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.spans.length).toEqual(2);
      expect(retrieved!.spans[1].id).toEqual(dbSpan.id);
      expect(retrieved!.spans[1].durationMs).toEqual(15);
    });
  });

  describe('Latency Distributions & Percentiles', () => {
    it('should compute p50, p75, p90, p95, p99 percentiles correctly', () => {
      for (let i = 1; i <= 100; i++) {
        const trace = service.startTrace(`HTTP GET /test-${i}`, 'http');
        service.endTrace(trace.id, { statusCode: 200, durationMs: i });
      }

      const dist = service.getLatencyDistributions();
      expect(dist.totalCount).toEqual(100);
      expect(dist.min).toEqual(1);
      expect(dist.max).toEqual(100);
      expect(dist.p50).toEqual(50);
      expect(dist.p95).toEqual(95);
      expect(dist.p99).toEqual(99);
    });
  });

  describe('Flame Graph Generation', () => {
    it('should build hierarchical flame graph structure with percentage allocation', () => {
      const trace = service.startTrace('HTTP GET /dashboard', 'http');

      const span1 = service.startSpan('DB:user', 'db', trace.rootSpan.id);
      service.endSpan(span1.id, 'ok', { durationMs: 40 });

      const span2 = service.startSpan('REDIS:GET', 'redis', trace.rootSpan.id);
      service.endSpan(span2.id, 'ok', { durationMs: 10 });

      service.endTrace(trace.id, { statusCode: 200, durationMs: 100 });

      const flameGraph = service.generateFlameGraph(trace.id);
      expect(flameGraph).not.toBeNull();
      expect(flameGraph!.name).toEqual('HTTP GET /dashboard');
      expect(flameGraph!.children.length).toEqual(2);
      expect(flameGraph!.children[0].name).toEqual('DB:user');
      expect(flameGraph!.children[0].value).toEqual(40);
    });
  });

  describe('Bottleneck Report', () => {
    it('should aggregate slow endpoints, slow database queries, Redis, RPC & queue bottlenecks', () => {
      const trace = service.startTrace('HTTP GET /claims', 'http', { route: '/claims', method: 'GET' });

      const dbSpan = service.startSpan('DB:claim', 'db', trace.rootSpan.id, {
        query: 'SELECT * FROM claim WHERE status = active',
        entity: 'claim',
      });
      service.endSpan(dbSpan.id, 'ok', { durationMs: 150, isSlowQuery: true });

      const redisSpan = service.startSpan('REDIS:GET', 'redis', trace.rootSpan.id, {
        command: 'GET',
        keyPattern: 'claim:*',
      });
      service.endSpan(redisSpan.id, 'ok', { durationMs: 30 });

      const rpcSpan = service.startSpan('RPC:optimism:eth_call', 'blockchain', trace.rootSpan.id, {
        method: 'eth_call',
      });
      service.endSpan(rpcSpan.id, 'ok', { durationMs: 250 });

      service.endTrace(trace.id, { statusCode: 200, durationMs: 500, route: '/claims', method: 'GET' });

      const report = service.generateBottleneckReport();
      expect(report).toBeDefined();
      expect(report.slowEndpoints.length).toBeGreaterThan(0);
      expect(report.slowQueries.length).toBeGreaterThan(0);
      expect(report.slowRedisOps.length).toBeGreaterThan(0);
      expect(report.slowBlockchainCalls.length).toBeGreaterThan(0);
      expect(report.cpuHotspots.length).toBeGreaterThan(0);
    });
  });

  describe('Historical Snapshots & Regression Detection', () => {
    it('should create snapshot and detect performance regressions', () => {
      // Baseline setup
      const t1 = service.startTrace('HTTP GET /claims', 'http', { route: '/claims', method: 'GET' });
      service.endTrace(t1.id, { statusCode: 200, route: '/claims', method: 'GET', durationMs: 50 });

      const baselineSnapshot = service.takeHistoricalSnapshot('baseline-v1');
      expect(baselineSnapshot.id).toBeDefined();

      // Target setup with degraded latency
      const t2 = service.startTrace('HTTP GET /claims', 'http', { route: '/claims', method: 'GET' });
      service.endTrace(t2.id, { statusCode: 200, route: '/claims', method: 'GET', durationMs: 150 });

      const targetSnapshot = service.takeHistoricalSnapshot('target-v2');

      const comparison = service.compareHistorical(baselineSnapshot.id, targetSnapshot.id);
      expect(comparison).not.toBeNull();
      expect(comparison!.latencyDelta.mean).toBeGreaterThan(0);

      const regressionReport = service.detectRegressions(baselineSnapshot.id, targetSnapshot.id, 20);
      expect(regressionReport.status).toEqual('regressions_detected');
      expect(regressionReport.regressions.length).toBeGreaterThan(0);
    });
  });
});
