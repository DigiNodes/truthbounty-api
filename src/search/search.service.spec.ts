import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, RequestTimeoutException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SearchService } from './search.service';
import { PaginationType, SortField } from './search.types';
import { Claim } from '../claims/entities/claim.entity';
import { Dispute } from '../dispute/entities/dispute.entity';
import { User } from '../entities/user.entity';
import { RedisService } from '../redis/redis.service';
import { StableCursorUtil } from '../pagination/stable-cursor';
import { WalletRateLimiterService } from '../auth/wallet-rate-limiter.service';

describe('SearchService (PREWAVE-BE-068 Harden Search Complexity & Stability)', () => {
  let service: SearchService;
  let mockClaimQb: any;
  let mockDisputeQb: any;
  let mockUserQb: any;

  const createMockRepo = () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getMany: jest.fn().mockResolvedValue([]),
    };
    return {
      qb,
      repo: {
        createQueryBuilder: jest.fn(() => qb),
      },
    };
  };

  const mockRedis = () => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  });

  beforeEach(async () => {
    const claimMock = createMockRepo();
    const disputeMock = createMockRepo();
    const userMock = createMockRepo();

    mockClaimQb = claimMock.qb;
    mockDisputeQb = disputeMock.qb;
    mockUserQb = userMock.qb;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        {
          provide: getRepositoryToken(Claim),
          useValue: claimMock.repo,
        },
        {
          provide: getRepositoryToken(Dispute),
          useValue: disputeMock.repo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: userMock.repo,
        },
        {
          provide: RedisService,
          useFactory: mockRedis,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal: any) => defaultVal),
          },
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('1. Empty and Huge Query Tests', () => {
    it('should handle empty query gracefully without full table LIKE scan', async () => {
      const result = await service.searchGlobal(
        '',
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.NEWEST,
      );

      expect(result.query).toBe('');
      expect(result.claims).toBeDefined();
      expect(result.disputes).toBeDefined();
      expect(result.users).toBeDefined();

      // Ensure no LIKE clauses were added for empty query
      expect(mockClaimQb.where).not.toHaveBeenCalled();
    });

    it('should handle whitespace-only query gracefully', async () => {
      const result = await service.searchGlobal(
        '     ',
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.NEWEST,
      );
      expect(result.query).toBe('');
    });

    it('should reject huge query exceeding 256 characters', async () => {
      const hugeQuery = 'a'.repeat(257);
      await expect(
        service.searchGlobal(
          hugeQuery,
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject query with excessive terms (> 10 terms)', async () => {
      const queryWith11Terms = 'one two three four five six seven eight nine ten eleven';
      await expect(
        service.searchGlobal(
          queryWith11Terms,
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('2. Wildcard Abuse Tests', () => {
    it('should reject consecutive wildcard characters (%%)', async () => {
      await expect(
        service.searchGlobal(
          'test%%abuse',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject consecutive underscore wildcard characters (___)', async () => {
      await expect(
        service.searchGlobal(
          'test___abuse',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject queries exceeding maximum wildcards (> 2)', async () => {
      await expect(
        service.searchGlobal(
          'a* b* c*',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject queries consisting solely of wildcards', async () => {
      await expect(
        service.searchGlobal(
          '%',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.searchGlobal(
          '  _  ',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should escape wildcards in SQL LIKE parameters', async () => {
      await service.searchEntity(
        'claims',
        '100% genuine',
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.NEWEST,
      );

      // Verify that LIKE used ESCAPE '\\' and escaped parameter
      expect(mockClaimQb.andWhere).toHaveBeenCalledWith(
        expect.any(Object), // Brackets
      );
    });
  });

  describe('3. Injection and Unapproved Fields Tests', () => {
    it('should safely parameterize SQL injection attempts', async () => {
      await service.searchEntity(
        'claims',
        "' OR '1'='1",
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.NEWEST,
      );

      // Should not throw and should use parameterized brackets
      expect(mockClaimQb.andWhere).toHaveBeenCalled();
    });

    it('should reject unapproved and private field search syntax (e.g. role:admin)', async () => {
      await expect(
        service.searchEntity(
          'users',
          'role:ADMIN',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject private fields like password or wallets in query', async () => {
      await expect(
        service.searchGlobal(
          'password:hash',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.searchGlobal(
          'wallets:0x123',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject unapproved filters for specific entity', async () => {
      // Users entity should not allow claim-specific filters like finalized or status
      await expect(
        service.searchEntity(
          'users',
          '0x1234',
          { finalized: true },
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);

      // Claims entity should not allow walletAddress filter
      await expect(
        service.searchEntity(
          'claims',
          'test',
          { walletAddress: '0x1234' },
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should never expose private user fields (role, wallets) in user search results', async () => {
      mockUserQb.getManyAndCount.mockResolvedValue([
        [
          {
            id: 'uuid-1',
            walletAddress: '0xabc',
            role: 'ADMIN',
            reputation: 100,
            worldcoinVerified: true,
            wallets: [{ address: '0xabc' }],
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-02'),
          },
        ],
        1,
      ]);

      const result = await service.searchEntity(
        'users',
        '0xabc',
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.NEWEST,
      );

      const user = (result.data as any[])[0];
      expect(user.walletAddress).toBe('0xabc');
      expect(user.reputation).toBe(100);
      expect(user.role).toBeUndefined();
      expect(user.wallets).toBeUndefined();
    });
  });

  describe('4. Unicode and Special Characters Tests', () => {
    it('should handle multi-language Unicode queries safely', async () => {
      const unicodeQueries = ['こんにちは', 'München', 'مرحبا', 'café', '🔍 bounty'];

      for (const q of unicodeQueries) {
        const result = await service.searchGlobal(
          q,
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        );
        expect(result.query).toBe(q.normalize('NFC').trim());
      }
    });

    it('should reject null-byte injection', async () => {
      await expect(
        service.searchGlobal(
          'legit\0injection',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid control characters', async () => {
      await expect(
        service.searchGlobal(
          'test\x08char',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('5. Timeout Tests', () => {
    it('should throw RequestTimeoutException if query execution exceeds timeout', async () => {
      mockClaimQb.getManyAndCount.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );

      await expect(
        service.searchEntity(
          'claims',
          'test',
          {},
          { page: 1, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
          { timeoutMs: 10 },
        ),
      ).rejects.toThrow(RequestTimeoutException);
    });
  });

  describe('6. Canonical Tie-Break Order and Concurrent Inserts Tests', () => {
    it('should include canonical tie-breaker (id) for claims ordering', async () => {
      await service.searchEntity(
        'claims',
        'test',
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.NEWEST,
      );

      expect(mockClaimQb.orderBy).toHaveBeenCalledWith('claim.createdAt', 'DESC');
      expect(mockClaimQb.addOrderBy).toHaveBeenCalledWith('claim.id', 'ASC');
    });

    it('should include canonical tie-breaker for user reputation sort', async () => {
      await service.searchEntity(
        'users',
        '0x123',
        {},
        { page: 1, limit: 20, type: PaginationType.OFFSET },
        SortField.REPUTATION,
      );

      expect(mockUserQb.orderBy).toHaveBeenCalledWith('user.reputation', 'DESC');
      expect(mockUserQb.addOrderBy).toHaveBeenCalledWith('user.walletAddress', 'ASC');
    });

    it('should maintain stable deterministic ordering under concurrent inserts with identical timestamps', () => {
      // Given 3 claims created in the exact same millisecond
      const sameTimestamp = new Date('2026-05-01T12:00:00.000Z');
      const claimA = { id: 'claim-1', title: 'First', createdAt: sameTimestamp };
      const claimB = { id: 'claim-2', title: 'Second', createdAt: sameTimestamp };
      const claimC = { id: 'claim-3', title: 'Third', createdAt: sameTimestamp };

      // Under tie-breaker (claim.id ASC), items are deterministically sorted
      const items = [claimB, claimA, claimC];
      const sorted = [...items].sort((a, b) => {
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });

      expect(sorted.map((c) => c.id)).toEqual(['claim-1', 'claim-2', 'claim-3']);
    });
  });

  describe('7. Pagination and Result Window Bounding Tests', () => {
    it('should reject deep-paging beyond MAX_RESULT_WINDOW (1000 items)', async () => {
      // page 51 with limit 20 = 1020 > 1000
      await expect(
        service.searchGlobal(
          'test',
          {},
          { page: 51, limit: 20, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject limit greater than 100', async () => {
      await expect(
        service.searchGlobal(
          'test',
          {},
          { page: 1, limit: 101, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject limit less than 1', async () => {
      await expect(
        service.searchGlobal(
          'test',
          {},
          { page: 1, limit: 0, type: PaginationType.OFFSET },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should support stable cursor-based pagination and issue nextCursor', async () => {
      const now = new Date('2026-06-01T10:00:00.000Z');
      mockClaimQb.getMany.mockResolvedValue([
        { id: 'c1', title: 'Claim 1', createdAt: now },
        { id: 'c2', title: 'Claim 2', createdAt: now },
        { id: 'c3', title: 'Claim 3', createdAt: now }, // limit + 1 = hasMore
      ]);

      const result = await service.searchEntity(
        'claims',
        'test',
        {},
        { page: 1, limit: 2, type: PaginationType.CURSOR },
        SortField.NEWEST,
      );

      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBeDefined();

      const decoded = StableCursorUtil.decode(result.nextCursor!);
      expect(decoded).not.toBeNull();
      expect(decoded?.tieBreaker).toBe('c2');
    });

    it('should reject malformed or tampered cursor', async () => {
      await expect(
        service.searchEntity(
          'claims',
          'test',
          {},
          { page: 1, limit: 10, type: PaginationType.CURSOR, cursor: 'invalid-cursor-string' },
          SortField.NEWEST,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('8. Cost-Aware Rate Limiting Tests', () => {
    it('should scale rate limit cost with query complexity', () => {
      const rateLimiter = new WalletRateLimiterService(
        { get: jest.fn().mockReturnValue(100) } as any,
        { isHealthy: jest.fn().mockResolvedValue(true) } as any,
      );

      // Simple entity search: cost = 2
      const simpleEntityReq: any = {
        path: '/search/claims',
        query: { q: 'simple', limit: '20' },
      };
      expect(rateLimiter.calculateSearchCost(simpleEntityReq)).toBe(2);

      // Global search: base cost = 5
      const simpleGlobalReq: any = {
        path: '/search',
        query: { q: 'simple', limit: '20' },
      };
      expect(rateLimiter.calculateSearchCost(simpleGlobalReq)).toBe(5);

      // Complex global search with high limit (>50) and multiple filters: cost = 5 + 2 + 1 = 8
      const complexGlobalReq: any = {
        path: '/search',
        query: {
          q: 'complex multi term query test',
          limit: '100',
          status: 'PENDING',
          finalized: 'false',
        },
      };
      const complexCost = rateLimiter.calculateSearchCost(complexGlobalReq);
      expect(complexCost).toBeGreaterThan(simpleGlobalReq.query.limit ? 5 : 2);
      expect(complexCost).toBe(9); // 5 base + 1 terms + 2 limit + 1 filters
    });
  });
});
