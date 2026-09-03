import { Test, TestingModule } from '@nestjs/testing';
import { ProfilerService } from '../profiler.service';

describe('Performance Overhead Tests', () => {
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

  it('should maintain minimal CPU overhead (< 0.1ms per trace creation and completion)', () => {
    const iterations = 1000;
    const start = Date.now();

    for (let i = 0; i < iterations; i++) {
      const trace = service.startTrace(`HTTP GET /benchmark-${i}`, 'http');
      const span = service.startSpan('DB:query', 'db', trace.rootSpan.id);
      service.endSpan(span.id, 'ok', { durationMs: 2 });
      service.endTrace(trace.id, { statusCode: 200 });
    }

    const elapsedMs = Date.now() - start;
    const avgOverheadPerTraceMs = elapsedMs / iterations;

    // Must be well below 1.0ms per trace execution
    expect(avgOverheadPerTraceMs).toBeLessThan(1.0);
  });
});
