import { UsageAnalyticsService } from './usage-analytics.service';
import { AiUsageEndpoint, AiUsageStatus } from '../entities/ai-usage-log.entity';

describe('UsageAnalyticsService', () => {
  let service: UsageAnalyticsService;
  let repository: { create: jest.Mock; save: jest.Mock; find: jest.Mock };

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation((entry) => entry),
      save: jest.fn().mockImplementation(async (entry) => ({
        id: 'log-1', createdAt: new Date(), ...entry,
      })),
      find: jest.fn(),
    };
    service = new UsageAnalyticsService(repository as any);
  });

  it('keeps missing paid actuals and historical prices unknown', async () => {
    await service.record({
      userId: 'user-1', provider: 'openai', endpoint: AiUsageEndpoint.CHAT,
      status: AiUsageStatus.ERROR,
    });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: null, completionTokens: null, totalTokens: null,
      usageComplete: false, costUsdNanos: null, priceVersion: null,
    }));
  });

  it('retains explicit zero mock actual usage without assigning a synthetic paid price', async () => {
    await service.record({
      userId: 'user-1', provider: 'mock', endpoint: AiUsageEndpoint.CHAT,
      status: AiUsageStatus.SUCCESS, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 0, completionTokens: 0, totalTokens: 0, usageComplete: true,
      costUsdNanos: null, priceVersion: null,
    }));
  });

  it('aggregates known bigint totals and preserves provider/status/endpoint breakdowns', async () => {
    repository.find.mockResolvedValue([
      { provider: 'mock', status: 'success', endpoint: 'chat', totalTokens: '10',
        latencyMs: 100, usageComplete: true, costUsdNanos: null },
      { provider: 'mock', status: 'success', endpoint: 'chat', totalTokens: 20,
        latencyMs: 200, usageComplete: true, costUsdNanos: null },
      { provider: 'openai', status: 'error', endpoint: 'stream', totalTokens: null,
        latencyMs: 50, usageComplete: false, costUsdNanos: null },
    ]);
    const summary = await service.getSummary({});
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalTokens).toBe(30);
    expect(summary.uncertainRequests).toBe(1);
    expect(summary.unpricedRequests).toBe(1);
    expect(summary.costUsdNanos).toBeNull();
    expect(summary.averageLatencyMs).toBe(Math.round(350 / 3));
    expect(summary.byProvider).toEqual({ mock: 2, openai: 1 });
    expect(summary.byStatus).toEqual({ success: 2, error: 1 });
    expect(summary.byEndpoint).toEqual({ chat: 2, stream: 1 });
  });

  it('preserves an exact decimal total above Number precision and known costs across price revisions', async () => {
    repository.find.mockResolvedValue([
      { provider: 'openai', status: 'success', endpoint: 'chat',
        totalTokens: '9007199254740993', latencyMs: 1, usageComplete: true, costUsdNanos: '7' },
      { provider: 'openai', status: 'success', endpoint: 'chat',
        totalTokens: '2', latencyMs: 1, usageComplete: true, costUsdNanos: '11' },
    ]);
    const summary = await service.getSummary({});
    expect(summary.totalTokens).toBe('9007199254740995');
    expect(summary.costUsdNanos).toBe('18');
  });

  it('never turns a historical paid zero/default token record into known spend', async () => {
    repository.find.mockResolvedValue([{
      provider: 'anthropic', status: 'error', endpoint: 'chat',
      totalTokens: 0, latencyMs: 3, usageComplete: false, costUsdNanos: null,
    }]);
    const summary = await service.getSummary({});
    expect(summary.costUsdNanos).toBeNull();
    expect(summary.uncertainRequests).toBe(1);
    expect(summary.unpricedRequests).toBe(1);
  });

  it('returns an empty known summary when there are no logs', async () => {
    repository.find.mockResolvedValue([]);
    expect(await service.getSummary({})).toEqual({
      totalRequests: 0, totalTokens: 0, averageLatencyMs: 0, uncertainRequests: 0,
      unpricedRequests: 0, costUsdNanos: '0', byProvider: {}, byStatus: {}, byEndpoint: {},
    });
  });
});
