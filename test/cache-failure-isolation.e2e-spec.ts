import { CacheHealthService } from '../src/cache/cache-health.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { RedisService } from '../src/redis/redis.service';

describe('Cache health metrics', () => {
  let service: CacheHealthService;
  const metrics = {
    incrementCounter: jest.fn(),
    setGauge: jest.fn(),
  };

  beforeEach(() => {
    service = new CacheHealthService(
      {} as RedisService,
      metrics as unknown as MetricsService,
    );
    metrics.incrementCounter.mockClear();
    metrics.setGauge.mockClear();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('records cache operation outcomes', () => {
    service.recordSuccess('GET');
    service.recordFailure('GET', 'test:key', new Error('Redis unavailable'));

    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'cache_operations_total',
      { operation: 'GET', status: 'success' },
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'cache_operations_total',
      { operation: 'GET', status: 'failure' },
    );
  });

  it('marks cache unhealthy after the failure threshold', () => {
    for (let i = 0; i < 11; i++) {
      service.recordFailure('GET', 'test:key', new Error('Redis unavailable'));
    }

    expect(service.getHealthStatus()).toMatchObject({
      healthy: false,
      failureCount: 11,
    });
  });
});
