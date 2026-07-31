import { ConfigService } from '@nestjs/config';
import { ContextRetrievalService } from './context-retrieval.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { AiMetricsService } from '../metrics/ai-metrics.service';
import {
  ContextDocument,
  ContextDocumentCategory,
} from '../entities/context-document.entity';

describe('ContextRetrievalService', () => {
  let service: ContextRetrievalService;
  let repository: { createQueryBuilder: jest.Mock };
  let cache: jest.Mocked<
    Pick<AiAssistantCache, 'getContextResults' | 'setContextResults'>
  >;
  let metrics: jest.Mocked<
    Pick<AiMetricsService, 'recordCacheHit' | 'recordCacheMiss'>
  >;
  let candidates: ContextDocument[];

  const buildQueryBuilder = () => {
    const qb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockImplementation(async () => candidates),
    };
    return qb;
  };

  beforeEach(() => {
    candidates = [
      {
        id: 'doc-1',
        title: 'Staking Overview',
        category: ContextDocumentCategory.PROTOCOL_DOCS,
        content: 'Staking locks tokens to back claims.',
        tags: ['staking'],
        sourceUrl: undefined,
        isActive: true,
        createdBy: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ContextDocument,
      {
        id: 'doc-2',
        title: 'Dispute Process',
        category: ContextDocumentCategory.MODERATION_POLICY,
        content: 'Disputes reference staking outcomes for weighting.',
        tags: ['disputes'],
        sourceUrl: undefined,
        isActive: true,
        createdBy: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ContextDocument,
    ];

    repository = {
      createQueryBuilder: jest.fn().mockImplementation(buildQueryBuilder),
    };
    cache = { getContextResults: jest.fn(), setContextResults: jest.fn() };
    metrics = { recordCacheHit: jest.fn(), recordCacheMiss: jest.fn() };
    const configService = {
      get: jest.fn().mockReturnValue({ contextTopN: 5 }),
    } as unknown as ConfigService;

    service = new ContextRetrievalService(
      repository as any,
      cache as unknown as AiAssistantCache,
      metrics as unknown as AiMetricsService,
      configService,
    );
  });

  it('returns cached results and records a cache hit without querying the repository', async () => {
    const cached = [
      { documentId: 'doc-1', title: 'Staking', content: 'x', score: 1 },
    ];
    cache.getContextResults.mockResolvedValue(cached);

    const results = await service.search('staking');

    expect(results).toEqual(cached);
    expect(metrics.recordCacheHit).toHaveBeenCalledWith('context');
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('ranks title matches above content-only matches and normalizes scores to [0,1]', async () => {
    cache.getContextResults.mockResolvedValue(null);

    const results = await service.search('staking');

    expect(metrics.recordCacheMiss).toHaveBeenCalledWith('context');
    expect(results[0].documentId).toBe('doc-1'); // "staking" is in doc-1's title (weight 3)
    expect(results[0].score).toBe(1);
    expect(results[1].score).toBeLessThan(1);
    expect(cache.setContextResults).toHaveBeenCalledWith(
      'staking',
      results,
      undefined,
    );
  });

  it('caps results to the requested topN', async () => {
    cache.getContextResults.mockResolvedValue(null);
    const results = await service.search('staking', { topN: 1 });
    expect(results).toHaveLength(1);
  });

  it('returns an empty array for a query with only stopwords', async () => {
    cache.getContextResults.mockResolvedValue(null);
    const results = await service.search('the a is');
    expect(results).toEqual([]);
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
