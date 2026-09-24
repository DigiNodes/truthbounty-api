import { Injectable } from '@nestjs/common';
import {
  Counter,
  CounterConfiguration,
  Gauge,
  GaugeConfiguration,
  Histogram,
  HistogramConfiguration,
  register,
} from 'prom-client';

export type AiRequestStatus =
  | 'success'
  | 'error'
  | 'fallback'
  | 'safety_blocked';
export type AiTokenType = 'prompt' | 'completion';
export type AiCacheType =
  | 'context'
  | 'conversation_window'
  | 'provider_availability';
export type AiEndpointLabel =
  | 'chat'
  | 'stream'
  | 'knowledge_base'
  | 'analytics';

/**
 * Registers on prom-client's default/shared registry — the same registry
 * MetricsService.getMetrics() reads via client.register.metrics() — so these
 * series appear on the existing GET /metrics with no controller changes.
 *
 * Uses named imports (not `import client from 'prom-client'`) — prom-client's
 * CJS build has no `default` export, and the default-import form resolves to
 * undefined under this project's ts-jest config.
 */
function getOrCreateCounter(
  config: CounterConfiguration<string>,
): Counter<string> {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as Counter<string>;
  return new Counter(config);
}

function getOrCreateHistogram(
  config: HistogramConfiguration<string>,
): Histogram<string> {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as Histogram<string>;
  return new Histogram(config);
}

function getOrCreateGauge(config: GaugeConfiguration<string>): Gauge<string> {
  const existing = register.getSingleMetric(config.name);
  if (existing) return existing as Gauge<string>;
  return new Gauge(config);
}

@Injectable()
export class AiMetricsService {
  private readonly requestsTotal = getOrCreateCounter({
    name: 'ai_requests_total',
    help: 'Total AI assistant requests by provider, endpoint, and outcome',
    labelNames: ['provider', 'endpoint', 'status'],
  });

  private readonly requestDuration = getOrCreateHistogram({
    name: 'ai_request_duration_seconds',
    help: 'AI assistant request latency in seconds',
    labelNames: ['provider', 'endpoint'],
    buckets: [0.5, 1, 2, 5, 10, 20],
  });

  private readonly tokensTotal = getOrCreateCounter({
    name: 'ai_tokens_total',
    help: 'Total tokens consumed by AI assistant requests',
    labelNames: ['provider', 'type'],
  });

  private readonly providerAvailability = getOrCreateGauge({
    name: 'ai_provider_availability',
    help: 'Last known availability of an AI provider (1 = available, 0 = unavailable)',
    labelNames: ['provider'],
  });

  private readonly cacheHits = getOrCreateCounter({
    name: 'ai_cache_hits_total',
    help: 'AI assistant cache hits by cache type',
    labelNames: ['cacheType'],
  });

  private readonly cacheMisses = getOrCreateCounter({
    name: 'ai_cache_misses_total',
    help: 'AI assistant cache misses by cache type',
    labelNames: ['cacheType'],
  });

  private readonly rateLimitedTotal = getOrCreateCounter({
    name: 'ai_rate_limited_total',
    help: 'AI assistant requests rejected by rate limiting, by throttle type',
    labelNames: ['throttleType'],
  });

  recordRequest(
    provider: string,
    endpoint: AiEndpointLabel,
    status: AiRequestStatus,
  ): void {
    this.requestsTotal.inc({ provider, endpoint, status });
  }

  observeLatency(
    provider: string,
    endpoint: AiEndpointLabel,
    seconds: number,
  ): void {
    this.requestDuration.observe({ provider, endpoint }, seconds);
  }

  recordTokens(provider: string, type: AiTokenType, count: number): void {
    if (count > 0) {
      this.tokensTotal.inc({ provider, type }, count);
    }
  }

  setProviderAvailability(provider: string, available: boolean): void {
    this.providerAvailability.set({ provider }, available ? 1 : 0);
  }

  recordCacheHit(cacheType: AiCacheType): void {
    this.cacheHits.inc({ cacheType });
  }

  recordCacheMiss(cacheType: AiCacheType): void {
    this.cacheMisses.inc({ cacheType });
  }

  recordRateLimited(throttleType: string): void {
    this.rateLimitedTotal.inc({ throttleType });
  }
}
