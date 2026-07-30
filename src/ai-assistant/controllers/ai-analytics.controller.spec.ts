import { AiAnalyticsController } from './ai-analytics.controller';

describe('AiAnalyticsController', () => {
  it('usage() delegates to UsageAnalyticsService.getSummary with the query', async () => {
    const usageAnalyticsService = {
      getSummary: jest.fn().mockResolvedValue({
        totalRequests: 5,
        totalTokens: 100,
        averageLatencyMs: 20,
        byProvider: {},
        byStatus: {},
        byEndpoint: {},
      }),
    };
    const controller = new AiAnalyticsController(usageAnalyticsService as any);

    const query = { provider: 'mock' };
    const result = await controller.usage(query as any);

    expect(usageAnalyticsService.getSummary).toHaveBeenCalledWith(query);
    expect(result.totalRequests).toBe(5);
  });
});
