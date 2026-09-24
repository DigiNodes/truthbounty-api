import { UsageAnalyticsService } from './usage-analytics.service';
import {
  AiUsageEndpoint,
  AiUsageStatus,
} from '../entities/ai-usage-log.entity';

describe('UsageAnalyticsService', () => {
  let service: UsageAnalyticsService;
  let repository: { create: jest.Mock; save: jest.Mock; find: jest.Mock };

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation((entry) => entry),
      save: jest.fn().mockImplementation(async (entry) => ({
        id: 'log-1',
        createdAt: new Date(),
        ...entry,
      })),
      find: jest.fn(),
    };
    service = new UsageAnalyticsService(repository as any);
  });

  it('persists a usage entry with sensible defaults for optional fields', async () => {
    await service.record({
      userId: 'user-1',
      provider: 'mock',
      endpoint: AiUsageEndpoint.CHAT,
      status: AiUsageStatus.SUCCESS,
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        cacheHit: false,
      }),
    );
    expect(repository.save).toHaveBeenCalled();
  });

  it('aggregates totals, and breakdowns by provider/status/endpoint', async () => {
    repository.find.mockResolvedValue([
      {
        provider: 'mock',
        status: 'success',
        endpoint: 'chat',
        totalTokens: 10,
        latencyMs: 100,
      },
      {
        provider: 'mock',
        status: 'success',
        endpoint: 'chat',
        totalTokens: 20,
        latencyMs: 200,
      },
      {
        provider: 'openai',
        status: 'error',
        endpoint: 'stream',
        totalTokens: 0,
        latencyMs: 50,
      },
    ]);

    const summary = await service.getSummary({});

    expect(summary.totalRequests).toBe(3);
    expect(summary.totalTokens).toBe(30);
    expect(summary.averageLatencyMs).toBe(Math.round((100 + 200 + 50) / 3));
    expect(summary.byProvider).toEqual({ mock: 2, openai: 1 });
    expect(summary.byStatus).toEqual({ success: 2, error: 1 });
    expect(summary.byEndpoint).toEqual({ chat: 2, stream: 1 });
  });

  it('returns a zeroed summary when there are no logs', async () => {
    repository.find.mockResolvedValue([]);
    const summary = await service.getSummary({});
    expect(summary).toEqual({
      totalRequests: 0,
      totalTokens: 0,
      averageLatencyMs: 0,
      byProvider: {},
      byStatus: {},
      byEndpoint: {},
    });
  });
});
