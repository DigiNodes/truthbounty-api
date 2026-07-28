import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SearchService } from './search.service';
import { Claim } from '../claims/entities/claim.entity';
import { Dispute } from '../dispute/entities/dispute.entity';
import { User } from '../entities/user.entity';
import { RedisService } from '../redis/redis.service';

describe('SearchService', () => {
  let service: SearchService;

  const createMockRepo = () => ({
    createQueryBuilder: jest.fn(() => ({
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    })),
  });

  const mockRedis = () => ({
    get: jest.fn(),
    set: jest.fn(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        {
          provide: getRepositoryToken(Claim),
          useValue: createMockRepo(),
        },
        {
          provide: getRepositoryToken(Dispute),
          useValue: createMockRepo(),
        },
        {
          provide: getRepositoryToken(User),
          useValue: createMockRepo(),
        },
        {
          provide: RedisService,
          useFactory: mockRedis,
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should perform global search', async () => {
    const result = await service.searchGlobal(
      'test',
      {},
      { page: 1, limit: 20, type: 'offset' },
      'newest',
    );

    expect(result.query).toBe('test');
    expect(result.claims).toBeDefined();
    expect(result.disputes).toBeDefined();
    expect(result.users).toBeDefined();
  });
});
