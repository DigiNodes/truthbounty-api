import { Test, TestingModule } from '@nestjs/testing';
import { RagService } from './rag.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { LlmProviderService } from './llm-provider.service';

describe('RagService', () => {
  let service: RagService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RagService,
        { provide: PrismaService, useValue: { contextDocument: { findMany: jest.fn().mockResolvedValue([]) } } },
        { provide: RedisService, useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(true) } },
        { provide: LlmProviderService, useValue: {} },
      ],
    }).compile();

    service = module.get<RagService>(RagService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
