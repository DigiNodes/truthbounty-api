import { register } from 'prom-client';
import { AiMetricsService } from './ai-metrics.service';

describe('AiMetricsService', () => {
  afterEach(() => {
    register.clear();
  });

  it('does not throw when constructed multiple times (registry-safe)', () => {
    expect(() => {
      new AiMetricsService();
      new AiMetricsService();
    }).not.toThrow();
  });

  it('increments ai_requests_total with provider/endpoint/status labels', async () => {
    const service = new AiMetricsService();
    service.recordRequest('mock', 'chat', 'success');

    const metric = await register.getSingleMetricAsString('ai_requests_total');
    expect(metric).toContain('provider="mock"');
    expect(metric).toContain('endpoint="chat"');
    expect(metric).toContain('status="success"');
  });

  it('observes request duration', async () => {
    const service = new AiMetricsService();
    service.observeLatency('mock', 'chat', 1.2);

    const metric = await register.getSingleMetricAsString(
      'ai_request_duration_seconds',
    );
    expect(metric).toContain(
      'ai_request_duration_seconds_count{provider="mock",endpoint="chat"} 1',
    );
  });

  it('records token counts by type, ignoring non-positive counts', async () => {
    const service = new AiMetricsService();
    service.recordTokens('mock', 'prompt', 10);
    service.recordTokens('mock', 'completion', 0);

    const metric = await register.getSingleMetricAsString('ai_tokens_total');
    expect(metric).toContain('provider="mock",type="prompt"} 10');
    expect(metric).not.toContain('type="completion"');
  });

  it('sets provider availability gauge', async () => {
    const service = new AiMetricsService();
    service.setProviderAvailability('openai', false);

    const metric = await register.getSingleMetricAsString(
      'ai_provider_availability',
    );
    expect(metric).toContain('provider="openai"} 0');
  });

  it('tracks cache hits and misses independently', async () => {
    const service = new AiMetricsService();
    service.recordCacheHit('context');
    service.recordCacheMiss('context');

    const hits = await register.getSingleMetricAsString('ai_cache_hits_total');
    const misses = await register.getSingleMetricAsString(
      'ai_cache_misses_total',
    );
    expect(hits).toContain('cacheType="context"} 1');
    expect(misses).toContain('cacheType="context"} 1');
  });

  it('tracks rate-limited requests by throttle type', async () => {
    const service = new AiMetricsService();
    service.recordRateLimited('ai');

    const metric = await register.getSingleMetricAsString(
      'ai_rate_limited_total',
    );
    expect(metric).toContain('throttleType="ai"} 1');
  });
});
