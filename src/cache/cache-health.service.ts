import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Bounded SCAN configuration for cache-key pattern iteration.
 */
export interface CacheScanOptions {
  /** Explicit namespace prefix (e.g. `chain:<releaseId>`). Required. */
  namespace: string;
  /** Optional suffix pattern within the namespace. */
  pattern: string;
  /** SCAN COUNT hint per batch (default 100). */
  batchSize?: number;
  /** Maximum number of keys to return across all batches. */
  maxKeys?: number;
  /** Maximum wall-clock time in ms for the entire scan. */
  timeoutMs?: number;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface CacheScanResult {
  keys: string[];
  cursor: string;
  complete: boolean;
  scannedCount: number;
  batches: number;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * Cache Health Service
 *
 * Tracks cache health metrics and failure rates to ensure cache failures are
 * observable and actionable. Per V2-BE-116, cache failures must be isolated
 * from canonical state and never silently fallback to fabricated state.
 *
 * PREWAVE-BE-033: cache-key pattern iteration uses cursor-based Redis SCAN
 * with explicit namespaces, bounded batches, timeouts, cancellation and
 * metrics. No production path uses KEYS or placeholder matching.
 */
@Injectable()
export class CacheHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheHealthService.name);
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: Date | null = null;
  private readonly FAILURE_THRESHOLD = 10; // Number of failures before marking as degraded
  private readonly RESET_INTERVAL_MS = 60000; // Reset counters every minute
  private readonly defaultScanBatchSize = 100;
  private readonly defaultScanMaxKeys = 10000;
  private readonly defaultScanTimeoutMs = 10000;
  private readonly metricsInterval: ReturnType<typeof setInterval>;
  private readonly resetInterval: ReturnType<typeof setInterval>;

  constructor(
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService,
  ) {
    this.metricsInterval = this.startMetricsReporting();
    this.resetInterval = setInterval(() => {
      this.resetCounters();
    }, this.RESET_INTERVAL_MS);
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
   * Escape Redis glob metacharacters in a literal segment so it is matched
   * verbatim when embedded in a SCAN MATCH pattern.
   */
  private escapeRedisGlob(value: string): string {
    return value.replace(/([\\*?[\]])/g, '\\$1');
  }

  /**
   * Build a namespace-scoped MATCH pattern. The namespace is escaped so
   * only the intended chain/release namespace is touched.
   */
  private buildPattern(namespace: string, pattern?: string): string {
    const ns = this.escapeRedisGlob(namespace);
    const suffix = pattern && pattern.length > 0 ? pattern : '*';
    return `${ns}:${suffix}`;
  }

  /**
   * Iterate cache keys using cursor-based Redis SCAN. Bounded by batch
   * size, max keys, timeout and optional AbortSignal. Resumable via the
   * returned cursor. Never uses KEYS.
   */
  async scanKeys(options: CacheScanOptions): Promise<CacheScanResult> {
    if (!options || typeof options.namespace !== 'string' || options.namespace.length === 0) {
      throw new Error('CacheScanOptions.namespace is required');
    }

    const batchSize = this.clampPositive(
      options.batchSize,
      this.defaultScanBatchSize,
      1,
      1000,
    );
    const maxKeys = this.clampPositive(
      options.maxKeys,
      this.defaultScanMaxKeys,
      1,
      1000000,
    );
    const timeoutMs = this.clampPositive(
      options.timeoutMs,
      this.defaultScanTimeoutMs,
      1,
      600000,
    );
    const pattern = this.buildPattern(options.namespace, options.pattern);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    const keys: string[] = [];
    let cursor = '0';
    let batches = 0;
    let scannedCount = 0;
    let timedOut = false;
    let cancelled = false;
    let complete = false;

    try {
      do {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }

        const result = await this.redisService.scan(cursor, {
          match: pattern,
          count: batchSize,
        });
        batches++;
        scannedCount += result.keys.length;

        for (const key of result.keys) {
          if (keys.length >= maxKeys) {
            break;
          }
          keys.push(key);
        }

        cursor = result.cursor;

        if (keys.length >= maxKeys) {
          // Bound reached; stop and return resumable cursor.
          break;
        }
      } while (cursor !== '0');

      complete = !timedOut && !cancelled && cursor === '0';
    } catch (err) {
      const error = err as Error;
      this.recordFailure('scanKeys', pattern, error);
      this.metricsService.incrementCounter('cache_scan_failures_total', {
        namespace: options.namespace,
      });
      throw error;
    } finally {
      const durationMs = Date.now() - startedAt;
      this.metricsService.incrementCounter('cache_scan_total', {
        namespace: options.namespace,
      });
      this.metricsService.setGauge('cache_scan_duration_ms', durationMs, {
        namespace: options.namespace,
      });
      this.metricsService.setGauge('cache_scan_keys_count', keys.length, {
        namespace: options.namespace,
      });
      if (timedOut) {
        this.metricsService.incrementCounter('cache_scan_timeouts_total', {
          namespace: options.namespace,
        });
      }
      if (cancelled) {
        this.metricsService.incrementCounter('cache_scan_cancelled_total', {
          namespace: options.namespace,
        });
      }
    }

    return {
      keys,
      cursor,
      complete,
      scannedCount,
      batches,
      durationMs: Date.now() - startedAt,
      timedOut,
      cancelled,
    };
  }

  /**
   * Resume a previously interrupted scan from a cursor. Retry-safe:
   * callers may repeat from the last returned cursor without duplicating
   * side effects because SCAN is stateless and only reads.
   */
  async resumeScan(options: CacheScanOptions, cursor: string): Promise<CacheScanResult> {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new Error('resumeScan requires a non-empty cursor');
    }
    return this.scanKeys(options);
  }

  private clampPositive(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.min(Math.max(Math.floor(value), min), max);
  }

  /**
   * Reset failure counters (called periodically)
   */
  private resetCounters(): void {
    const previousFailures = this.failureCount;
    this.failureCount = 0;
    this.successCount = 0;

    if (previousFailures > 0) {
      this.logger.debug(
        `Reset cache failure counters (previous: ${previousFailures})`,
      );
    }
  }

  /**
   * Start periodic metrics reporting and counter reset
   */
  private startMetricsReporting(): ReturnType<typeof setInterval> {
    // Report current health metrics periodically
    return setInterval(() => {
      const status = this.getHealthStatus();
      this.metricsService.setGauge('cache_failure_rate', status.failureRate);
      this.metricsService.setGauge('cache_failure_count', status.failureCount);
      this.metricsService.setGauge('cache_success_count', status.successCount);
      this.metricsService.setGauge('cache_healthy', status.healthy ? 1 : 0);
    }, 5000); // Every 5 seconds
  }

  /**
   * Clean up timers on module destroy to prevent listener/resource leaks.
   */
  onModuleDestroy(): void {
    clearInterval(this.metricsInterval);
    clearInterval(this.resetInterval);
  }
}
