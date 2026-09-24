import { Test, TestingModule } from '@nestjs/testing';
import { ProfilerController } from '../profiler.controller';
import { ProfilerService } from '../profiler.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ProfilerController', () => {
  let controller: ProfilerController;
  let service: ProfilerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProfilerController],
      providers: [ProfilerService],
    }).compile();

    controller = module.get<ProfilerController>(ProfilerController);
    service = module.get<ProfilerService>(ProfilerService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return summary information', () => {
    const summary = controller.getSummary();
    expect(summary.service).toContain('TruthBounty Profiling Service');
    expect(summary.status).toEqual('active');
  });

  it('should return latency metrics', () => {
    const metrics = controller.getMetrics();
    expect(metrics.timestamp).toBeDefined();
    expect(metrics.latency).toBeDefined();
  });

  it('should list and filter traces', () => {
    const trace = service.startTrace('HTTP GET /health', 'http');
    service.endTrace(trace.id, { statusCode: 200, route: '/health' });

    const result = controller.getTraces('/health');
    expect(result.count).toBeGreaterThan(0);
    expect(result.traces[0].route).toEqual('/health');
  });

  it('should return detailed trace by ID or throw NotFoundException', () => {
    const trace = service.startTrace('HTTP GET /test', 'http');
    service.endTrace(trace.id, { statusCode: 200 });

    const retrieved = controller.getTraceById(trace.id);
    expect(retrieved.id).toEqual(trace.id);

    expect(() => controller.getTraceById('invalid-id')).toThrow(NotFoundException);
  });

  it('should return flame graph by ID or throw NotFoundException', () => {
    const trace = service.startTrace('HTTP GET /flame', 'http');
    service.endTrace(trace.id, { statusCode: 200 });

    const result = controller.getFlameGraph(trace.id);
    expect(result.traceId).toEqual(trace.id);
    expect(result.flameGraph).toBeDefined();

    expect(() => controller.getFlameGraph('non-existent')).toThrow(NotFoundException);
  });

  it('should return bottleneck report', () => {
    const report = controller.getBottleneckReport();
    expect(report.generatedAt).toBeDefined();
  });

  it('should create and list historical snapshots', () => {
    const res = controller.takeSnapshot('v1.0.0-release');
    expect(res.message).toBeDefined();
    expect(res.snapshot.name).toEqual('v1.0.0-release');

    const list = controller.getSnapshots();
    expect(list.count).toBeGreaterThan(0);

    expect(() => controller.takeSnapshot('')).toThrow(BadRequestException);
  });

  it('should compare snapshots and detect regressions', () => {
    const s1 = service.takeHistoricalSnapshot('base');
    const s2 = service.takeHistoricalSnapshot('target');

    const cmp = controller.compareSnapshots(s1.id, s2.id);
    expect(cmp).not.toBeNull();

    const reg = controller.detectRegressions(s1.id, s2.id, '20');
    expect(reg.status).toBeDefined();

    expect(() => controller.compareSnapshots('', '')).toThrow(BadRequestException);
    expect(() => controller.detectRegressions('', '')).toThrow(BadRequestException);
  });

  it('should get and update sampling config', () => {
    const cfg = controller.getSamplingConfig();
    expect(cfg.enabled).toBe(true);

    const updated = controller.updateSamplingConfig({ defaultSampleRate: 0.5 });
    expect(updated.config.defaultSampleRate).toEqual(0.5);
  });

  it('should return HTML dashboard', () => {
    const html = controller.getDashboard();
    expect(html).toContain('TruthBounty Profiling Dashboard');
  });
});
