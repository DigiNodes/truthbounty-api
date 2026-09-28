import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Cache Health Service
 *
 * Tracks cache health metrics and failure rates to ensure cache failures are
 * observable and actionable. Per V2-BE-116, cache failures must be isolated
 * from canonical state and never silently fallback to fabricated state.
 */
@Injectable()
export class CacheHealthService {
  private readonly logger = new Logger(CacheHealthService.name);
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: Date | null = null;
  private readonly FAILURE_THRESHOLD = 10; // Number of failures before marking as degraded
  private readonly RESET_INTERVAL_MS = 60000; // Reset counters every minute

  constructor(
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService,
  ) {
    this.startMetricsReporting();
  }

  /**
   * Record a successful cache operation
   */
  recordSuccess(operation: string): void {
    this.successCount++;
    this.metricsService.incrementCounter('cache_operations_total', {
      operation,
      status: 'success',
    });
  }

  /**
   * Record a failed cache operation
   */
  recordFailure(operation: string, key?: string, error?: Error): void {
    this.failureCount++;
    this.lastFailureTime = new Date();
    
    this.metricsService.incrementCounter('cache_operations_total', {
      operation,
      status: 'failure',
    });

    this.metricsService.incrementCounter('cache_failures_total', {
      operation,
    });

    // Log the failure for observability
    this.logger.error(
      `Cache operation failed: ${operation}${key ? ` (key: ${key})` : ''}`,
      error?.stack,
    );

    // Alert if failure threshold exceeded
    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.logger.error(
        `Cache failure threshold exceeded: ${this.failureCount} failures in current window`,
      );
      this.metricsService.incrementCounter('cache_degraded_total');
    }
  }

  /**
   * Get current cache health status
   */
  getHealthStatus(): {
    healthy: boolean;
    failureCount: number;
    successCount: number;
    failureRate: number;
    lastFailureTime: Date | null;
    redisConnected: boolean;
  } {
    const total = this.failureCount + this.successCount;
    const failureRate = total > 0 ? this.failureCount / total : 0;
    const redisConnected = this.redisService.getStatus().connected;

    return {
      healthy: this.failureCount < this.FAILURE_THRESHOLD && redisConnected,
      failureCount: this.failureCount,
      successCount: this.successCount,
      failureRate,
      lastFailureTime: this.lastFailureTime,
      redisConnected,
    };
  }

  /**
   * Check if cache is healthy enough to use
   */
  isCacheHealthy(): boolean {
    const status = this.getHealthStatus();
    return status.healthy;
  }

  /**
   * Reset failure counters (called periodically)
   */
  private resetCounters(): void {
    const previousFailures = this.failureCount;
    this.failureCount = 0;
    this.successCount = 0;
    
    if (previousFailures > 0) {
      this.logger.debug(`Reset cache failure counters (previous: ${previousFailures})`);
    }
  }

  /**
   * Start periodic metrics reporting and counter reset
   */
  private startMetricsReporting(): void {
    // Report current health metrics periodically
    setInterval(() => {
      const status = this.getHealthStatus();
      this.metricsService.setGauge('cache_failure_rate', status.failureRate);
      this.metricsService.setGauge('cache_failure_count', status.failureCount);
      this.metricsService.setGauge('cache_success_count', status.successCount);
      this.metricsService.setGauge('cache_healthy', status.healthy ? 1 : 0);
    }, 5000); // Every 5 seconds

    // Reset counters periodically
    setInterval(() => {
      this.resetCounters();
    }, this.RESET_INTERVAL_MS);
  }
}
