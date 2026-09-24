import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClaimFeedService } from './claim-feed.service';
import { Claim } from '../entities/claim.entity';
import { IndexedEvent } from '../../entities/indexed-event.entity';
import { Stake } from '../../staking/entities/stake.entity';
import { ClaimsCache } from '../../cache/claims.cache';

describe('ClaimFeedService', () => {
  let service: ClaimFeedService;
  let claimRepo: Repository<Claim>;
  let indexedEventRepo: Repository<IndexedEvent>;
  let stakeRepo: Repository<Stake>;
  let claimsCache: ClaimsCache;

  function makeClaim(overrides: Partial<Claim> = {}): Claim {
    return {
      id: '00000000-0000-0000-0000-00000000000a',
      title: 'Test claim',
      content: 'Content',
      source: null,
      metadata: null,
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
      createdAt: new Date('2026-08-28T10:00:00Z'),
      resolvedAt: null,
      deadline: null,
      effectiveAt: null,
      evidences: [],
      getCurrentState() {
        if (this.finalized) return 'FINALIZED' as any;
        if (this.resolvedVerdict !== null && this.confidenceScore !== null) return 'RESOLVED' as any;
        return 'PENDING' as any;
      },
      ...overrides,
    } as Claim;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimFeedService,
        {
          provide: getRepositoryToken(Claim),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(IndexedEvent),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Stake),
          useClass: Repository,
        },
        {
          provide: ClaimsCache,
          useValue: {
            getClaim: jest.fn(),
            setClaim: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ClaimFeedService>(ClaimFeedService);
    claimRepo = module.get<Repository<Claim>>(getRepositoryToken(Claim));
    indexedEventRepo = module.get<Repository<IndexedEvent>>(getRepositoryToken(IndexedEvent));
    stakeRepo = module.get<Repository<Stake>>(getRepositoryToken(Stake));
    claimsCache = module.get<ClaimsCache>(ClaimsCache);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getFeed', () => {
    it('should return empty feed when no claims exist', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);

      const result = await service.getFeed({ limit: 20, cursor: undefined, state: undefined, creator: undefined, from: undefined, to: undefined });

      expect(result.data).toEqual([]);
      expect(result.pagination.nextCursor).toBeNull();
      expect(result.pagination.hasMore).toBe(false);
    });

    it('should return a paginated feed ordered by effectiveAt DESC', async () => {
      const claim1 = makeClaim({ id: 'a1', effectiveAt: new Date('2026-08-30T12:00:00Z') });
      const claim2 = makeClaim({ id: 'a2', effectiveAt: new Date('2026-08-29T12:00:00Z') });

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([claim1, claim2]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);
      jest.spyOn(indexedEventRepo, 'findOne').mockResolvedValue(null);

      const result = await service.getFeed({ limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('a1');
      expect(result.data[0].lifecycleState).toBe('PENDING');
      expect(result.data[0].links.self).toBe('/api/v2/claims/a1');
      expect(result.pagination.hasMore).toBe(false);
    });

    it('should set hasMore true and nextCursor when more rows than limit', async () => {
      const claims = Array.from({ length: 21 }, (_, i) =>
        makeClaim({ id: `id-${i}`, effectiveAt: new Date(2026, 7, 30, 0, i) }),
      );
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(claims),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);
      jest.spyOn(indexedEventRepo, 'findOne').mockResolvedValue(null);

      const result = await service.getFeed({ limit: 20 });

      expect(result.data).toHaveLength(20);
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.nextCursor).toBeTruthy();
    });

    it('should apply cursor condition when cursor is provided', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);

      const cursorPayload = { effectiveAt: '2026-08-30T12:00:00.000Z', id: 'lastid' };
      const cursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64url');

      await service.getFeed({ limit: 20, cursor });

      expect(qb.where).toHaveBeenCalledWith(
        expect.stringContaining(':cursorDate'),
        { cursorDate: expect.any(Date), cursorId: 'lastid' },
      );
    });

    it('should throw BadRequestException for an invalid cursor', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);

      await expect(service.getFeed({ limit: 20, cursor: '!!!not-valid!!' })).rejects.toThrow(BadRequestException);
    });

    it('should apply state filter for RESOLVED', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);

      await service.getFeed({ limit: 20, state: 'RESOLVED' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('resolvedVerdict'),
        expect.any(Object),
      );
    });

    it('should apply creator filter via stake join', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);

      await service.getFeed({ limit: 20, creator: '0xabc' });

      expect(qb.innerJoin).toHaveBeenCalled();
    });

    it('should apply from/to date range filters', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      jest.spyOn(claimRepo, 'createQueryBuilder').mockReturnValue(qb as any);

      await service.getFeed({ limit: 20, from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z' });

      expect(qb.andWhere).toHaveBeenCalledTimes(2);
    });
  });

  describe('getDetail', () => {
    it('should return full detail for an existing claim', async () => {
      const claim = makeClaim({
        id: 'detail-1',
        title: 'Detailed claim',
        resolvedVerdict: true,
        confidenceScore: 0.85,
        finalized: false,
      });
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(null);
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(claim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(indexedEventRepo, 'findOne').mockResolvedValue(null);

      const result = await service.getDetail('detail-1');

      expect(result.id).toBe('detail-1');
      expect(result.lifecycleState).toBe('RESOLVED');
      expect(result.confidenceScore).toBe(0.85);
      expect(result.resolvedVerdict).toBe(true);
      expect(result.links.self).toBe('/api/v2/claims/detail-1');
      expect(result.links.evidence).toBe('/api/v2/claims/detail-1/evidence');
      expect(result.links.stakes).toBe('/api/v2/claims/detail-1/stakes');
    });

    it('should use cached claim when available', async () => {
      const claim = makeClaim({ id: 'cached-1', title: 'Cached claim' });
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(claim);
      jest.spyOn(indexedEventRepo, 'findOne').mockResolvedValue(null);

      const result = await service.getDetail('cached-1');

      expect(result.title).toBe('Cached claim');
      expect(claimRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when claim does not exist', async () => {
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(null);
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(null);

      await expect(service.getDetail('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('confirmations metadata', () => {
    it('should return default confirmations when no indexed event present', async () => {
      const claim = makeClaim({ id: 'conf1' });
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(claim);
      jest.spyOn(indexedEventRepo, 'findOne').mockResolvedValue(null);

      const result = await service.getDetail('conf1');

      expect(result.confirmations).toEqual({
        current: 0,
        required: 12,
        finalized: false,
      });
    });

    it('should reflect indexed event finality when present', async () => {
      const claim = makeClaim({ id: 'conf2' });
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(null);
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(claim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(indexedEventRepo, 'findOne').mockResolvedValue({
        confirmations: 40,
        isFinalized: true,
      } as IndexedEvent);

      const result = await service.getDetail('conf2');

      expect(result.confirmations.finalized).toBe(true);
      expect(result.confirmations.current).toBe(40);
      expect(result.confirmations.required).toBe(12);
    });
  });
});
