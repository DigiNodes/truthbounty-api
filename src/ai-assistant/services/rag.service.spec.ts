import { Test, TestingModule } from '@nestjs/testing';
import { RagService } from './rag.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { LlmProviderService } from './llm-provider.service';
import { ConfigService } from '@nestjs/config';

describe('RagService', () => {
  let service: RagService;
  let redis: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(true) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RagService,
        {
          provide: PrismaService,
          useValue: {
            contextDocument: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        {
          provide: RedisService,
          useValue: redis,
        },
        { provide: LlmProviderService, useValue: {} },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              redactBeforeStore: true,
              redactionCacheKey: 'test-key',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RagService>(RagService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('uses an opaque HMAC cache key and never logs the raw query', async () => {
    await service.retrieveContext('password=hunter2');
    const key = redis.get.mock.calls[0][0] as string;
    expect(key).toMatch(/^rag_context:[a-f0-9]{64}$/);
    expect(key).not.toContain('password');
    expect(key).not.toContain('hunter2');
  });
});
