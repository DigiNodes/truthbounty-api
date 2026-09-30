import { CacheHealthService } from './cache-health.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';

describe('CacheHealthService', () => {
  let service: CacheHealthService;
  let redisService: jest.Mocked<RedisService>;
  let metricsService: jest.Mocked<MetricsService>;

  beforeEach(() => {
    redisService = {
      getStatus: jest.fn().mockReturnValue({ connected: true, enabled: true }),
    } as unknown as jest.Mocked<RedisService>;

    metricsService = {
      incrementCounter: jest.fn(),
      setGauge: jest.fn(),
    } as unknown as jest.Mocked<MetricsService>;

    service = new CacheHealthService(redisService, metricsService);
  });

  describe('recordSuccess', () => {
    it('should increment success count and record metrics', () => {
      service.recordSuccess('GET');

      const status = service.getHealthStatus();
      expect(status.successCount).toBe(1);
      expect(status.failureCount).toBe(0);
      expect(metricsService.incrementCounter).toHaveBeenCalledWith(
        'cache_operations_total',
        { operation: 'GET', status: 'success' },
      );
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count and record metrics', () => {
      const error = new Error('Redis connection failed');
      service.recordFailure('GET', 'test:key', error);

      const status = service.getHealthStatus();
      expect(status.failureCount).toBe(1);
      expect(status.successCount).toBe(0);
      expect(metricsService.incrementCounter).toHaveBeenCalledWith(
        'cache_operations_total',
        { operation: 'GET', status: 'failure' },
      );
      expect(metricsService.incrementCounter).toHaveBeenCalledWith(
        'cache_failures_total',
        { operation: 'GET' },
      );
    });

    it('should record last failure time', () => {
      const error = new Error('Redis connection failed');
      service.recordFailure('SET', 'test:key', error);

      const status = service.getHealthStatus();
      expect(status.lastFailureTime).toBeInstanceOf(Date);
    });
  });

  describe('getHealthStatus', () => {
    it('should return healthy status when below threshold', () => {
      service.recordSuccess('GET');
      service.recordSuccess('GET');

      const status = service.getHealthStatus();
      expect(status.healthy).toBe(true);
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(2);
      expect(status.failureRate).toBe(0);
      expect(status.redisConnected).toBe(true);
    });

    it('should return unhealthy when failure threshold exceeded', () => {
      // Record 10 failures to exceed threshold
      for (let i = 0; i < 10; i++) {
        service.recordFailure('GET', 'test:key', new Error('Failed'));
      }

      const status = service.getHealthStatus();
      expect(status.healthy).toBe(false);
      expect(status.failureCount).toBe(10);
    });

    it('should calculate failure rate correctly', () => {
      service.recordSuccess('GET');
      service.recordSuccess('GET');
      service.recordFailure('GET', 'test:key', new Error('Failed'));

      const status = service.getHealthStatus();
      expect(status.failureRate).toBe(0.3333333333333333); // 1/3
    });

    it('should return unhealthy when Redis disconnected', () => {
      redisService.getStatus.mockReturnValue({
        connected: false,
        enabled: true,
      });

      const status = service.getHealthStatus();
      expect(status.healthy).toBe(false);
      expect(status.redisConnected).toBe(false);
    });
  });

  describe('isCacheHealthy', () => {
    it('should return true when cache is healthy', () => {
      service.recordSuccess('GET');

      expect(service.isCacheHealthy()).toBe(true);
    });

    it('should return false when failure threshold exceeded', () => {
      for (let i = 0; i < 10; i++) {
        service.recordFailure('GET', 'test:key', new Error('Failed'));
      }

      expect(service.isCacheHealthy()).toBe(false);
    });

    it('should return false when Redis disconnected', () => {
      redisService.getStatus.mockReturnValue({
        connected: false,
        enabled: true,
      });

      expect(service.isCacheHealthy()).toBe(false);
    });
  });
});
