import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';

@Injectable()
export class FeatureFlagsMetricsService {
  private readonly activeFlagsGauge: Gauge<string>;
  private readonly disabledFlagsGauge: Gauge<string>;
  private readonly configChangesCounter: Counter<string>;
  private readonly cacheHitRatioGauge: Gauge<string>;
  private readonly refreshLatencyHistogram: Histogram<string>;

  constructor() {
    this.activeFlagsGauge = new Gauge({
      name: 'feature_flags_active_total',
      help: 'Total number of active feature flags',
      labelNames: ['environment'],
    });

    this.disabledFlagsGauge = new Gauge({
      name: 'feature_flags_disabled_total',
      help: 'Total number of disabled feature flags',
      labelNames: ['environment'],
    });

    this.configChangesCounter = new Counter({
      name: 'configuration_changes_total',
      help: 'Total number of configuration changes',
      labelNames: ['environment', 'type'],
    });

    this.cacheHitRatioGauge = new Gauge({
      name: 'feature_flags_cache_hit_ratio',
      help: 'Cache hit ratio for feature flags',
      labelNames: ['environment'],
    });

    this.refreshLatencyHistogram = new Histogram({
      name: 'config_refresh_latency_seconds',
      help: 'Latency of configuration refresh',
      labelNames: ['environment'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1],
    });
  }

  recordActiveFlags(environment: string, count: number) {
    this.activeFlagsGauge.set({ environment }, count);
  }

  recordDisabledFlags(environment: string, count: number) {
    this.disabledFlagsGauge.set({ environment }, count);
  }

  incrementConfigChanges(environment: string, type: 'flag' | 'config') {
    this.configChangesCounter.inc({ environment, type });
  }

  recordCacheHitRatio(environment: string, ratio: number) {
    this.cacheHitRatioGauge.set({ environment }, ratio);
  }

  observeRefreshLatency(environment: string, latencySeconds: number) {
    this.refreshLatencyHistogram.observe({ environment }, latencySeconds);
  }
}
