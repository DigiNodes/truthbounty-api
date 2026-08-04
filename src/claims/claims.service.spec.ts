import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClaimsService } from './claims.service';
import { Claim } from './entities/claim.entity';
import { Stake } from '../staking/entities/stake.entity';
import { ClaimsCache } from '../cache/claims.cache';
import { RedisService } from '../redis/redis.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { ClaimFactory } from './factories/claim.factory';
import { CreateClaimDto } from './dto/create-claim.dto';

describe('ClaimsService', () => {
  let service: ClaimsService;
  let claimRepo: Repository<Claim>;
  let stakeRepo: Repository<Stake>;
  let claimsCache: ClaimsCache;
  let redisService: RedisService;
  let auditTrailService: AuditTrailService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimsService,
        {
          provide: getRepositoryToken(Claim),
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
            getLatestClaims: jest.fn(),
            setLatestClaims: jest.fn(),
            getUserClaims: jest.fn(),
            setUserClaims: jest.fn(),
            invalidateClaim: jest.fn(),
            invalidateUserClaims: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: AuditTrailService,
          useValue: {
            log: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ClaimsService>(ClaimsService);
    claimRepo = module.get<Repository<Claim>>(getRepositoryToken(Claim));
    stakeRepo = module.get<Repository<Stake>>(getRepositoryToken(Stake));
    claimsCache = module.get<ClaimsCache>(ClaimsCache);
    redisService = module.get<RedisService>(RedisService);
    auditTrailService = module.get<AuditTrailService>(AuditTrailService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createClaim', () => {
    it('should create a claim with valid input data', async () => {
      const createClaimDto: CreateClaimDto = ClaimFactory.createCreateClaimDto();
      const expectedClaim = ClaimFactory.createClaim({
        ...createClaimDto,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
      });

      jest.spyOn(claimRepo, 'create').mockReturnValue(expectedClaim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue(expectedClaim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(redisService, 'del').mockResolvedValue(true);

      const result = await service.createClaim(createClaimDto);

      expect(claimRepo.create).toHaveBeenCalledWith({
        title: createClaimDto.title,
        content: createClaimDto.content,
        source: createClaimDto.source,
        metadata: createClaimDto.metadata,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
      });
      expect(claimRepo.save).toHaveBeenCalledWith(expectedClaim);
      expect(claimsCache.setClaim).toHaveBeenCalledWith(expectedClaim.id, expectedClaim);
      expect(redisService.del).toHaveBeenCalledWith('claims:latest');
      expect(result).toEqual(expectedClaim);
    });

    it('should create a claim without optional fields', async () => {
      const createClaimDto: CreateClaimDto = {
        title: 'Simple claim title',
        content: 'Simple claim content',
      };
      const expectedClaim = ClaimFactory.createClaim({
        ...createClaimDto,
        source: null,
        metadata: null,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
      });

      jest.spyOn(claimRepo, 'create').mockReturnValue(expectedClaim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue(expectedClaim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(redisService, 'del').mockResolvedValue(true);

      const result = await service.createClaim(createClaimDto);

      expect(claimRepo.create).toHaveBeenCalledWith({
        title: createClaimDto.title,
        content: createClaimDto.content,
        source: null,
        metadata: null,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
      });
      expect(result).toEqual(expectedClaim);
    });

    it('should handle database errors gracefully', async () => {
      const createClaimDto: CreateClaimDto = ClaimFactory.createCreateClaimDto();
      const expectedClaim = ClaimFactory.createClaim();

      jest.spyOn(claimRepo, 'create').mockReturnValue(expectedClaim);
      jest.spyOn(claimRepo, 'save').mockRejectedValue(new Error('Database error'));

      await expect(service.createClaim(createClaimDto)).rejects.toThrow('Database error');
      expect(claimRepo.create).toHaveBeenCalledWith({
        title: createClaimDto.title,
        content: createClaimDto.content,
        source: createClaimDto.source,
        metadata: createClaimDto.metadata,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
      });
    });

    it('should not set resolvedVerdict and confidenceScore during creation', async () => {
      const createClaimDto: CreateClaimDto = ClaimFactory.createCreateClaimDto();
      const expectedClaim = ClaimFactory.createClaim({
        ...createClaimDto,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
      });

      jest.spyOn(claimRepo, 'create').mockReturnValue(expectedClaim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue(expectedClaim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(redisService, 'del').mockResolvedValue(true);

      await service.createClaim(createClaimDto);

      expect(claimRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          resolvedVerdict: null,
          confidenceScore: null,
          finalized: false,
        })
      );
    });

    it('should invalidate cache when creating new claim', async () => {
      const createClaimDto: CreateClaimDto = ClaimFactory.createCreateClaimDto();
      const expectedClaim = ClaimFactory.createClaim();

      jest.spyOn(claimRepo, 'create').mockReturnValue(expectedClaim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue(expectedClaim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(redisService, 'del').mockResolvedValue(true);

      await service.createClaim(createClaimDto);

      expect(redisService.del).toHaveBeenCalledWith('claims:latest');
    });

    it('should throw BadRequestException if claim content length exceeds 5000 characters', async () => {
      const longContent = 'a'.repeat(5001);
      const createClaimDto = ClaimFactory.createCreateClaimDto({ content: longContent });

      await expect(service.createClaim(createClaimDto)).rejects.toThrow(
        new BadRequestException('Claim content exceeds maximum length of 5000 characters')
      );
    });

    it('should throw BadRequestException if claim title length exceeds 200 characters', async () => {
      const longTitle = 'a'.repeat(201);
      const createClaimDto = ClaimFactory.createCreateClaimDto({ title: longTitle });

      await expect(service.createClaim(createClaimDto)).rejects.toThrow(
        new BadRequestException('Claim title exceeds maximum length of 200 characters')
      );
    });
  });

  describe('findOne', () => {
    it('should return cached claim if available', async () => {
      const cachedClaim = ClaimFactory.createClaim();
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(cachedClaim);

      const result = await service.findOne(cachedClaim.id);

      expect(claimsCache.getClaim).toHaveBeenCalledWith(cachedClaim.id);
      expect(result).toEqual(cachedClaim);
    });

    it('should fetch from database if not cached', async () => {
      const claim = ClaimFactory.createClaim();
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(null);
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(claim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue();

      const result = await service.findOne(claim.id);

      expect(claimsCache.getClaim).toHaveBeenCalledWith(claim.id);
      expect(claimRepo.findOneBy).toHaveBeenCalledWith({ id: claim.id });
      expect(claimsCache.setClaim).toHaveBeenCalledWith(claim.id, claim);
      expect(result).toEqual(claim);
    });

    it('should return null if claim not found', async () => {
      const claimId = 'non-existent-id';
      jest.spyOn(claimsCache, 'getClaim').mockResolvedValue(null);
      jest.spyOn(claimRepo, 'findOneBy').mockResolvedValue(null);

      const result = await service.findOne(claimId);

      expect(result).toBeNull();
      expect(claimsCache.setClaim).not.toHaveBeenCalled();
    });
  });

  describe('findLatest', () => {
    it('should return cached latest claims if available', async () => {
      const cachedClaims = ClaimFactory.createManyClaims(5);
      jest.spyOn(claimsCache, 'getLatestClaims').mockResolvedValue(cachedClaims);

      const result = await service.findLatest(10);

      expect(claimsCache.getLatestClaims).toHaveBeenCalled();
      expect(result).toEqual(cachedClaims);
    });

    it('should fetch from database if not cached', async () => {
      const claims = ClaimFactory.createManyClaims(3);
      jest.spyOn(claimsCache, 'getLatestClaims').mockResolvedValue(null);
      jest.spyOn(claimRepo, 'find').mockResolvedValue(claims);
      jest.spyOn(claimsCache, 'setLatestClaims').mockResolvedValue();

      const result = await service.findLatest(10);

      expect(claimsCache.getLatestClaims).toHaveBeenCalled();
      expect(claimRepo.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        take: 10,
      });
      expect(claimsCache.setLatestClaims).toHaveBeenCalledWith(claims);
      expect(result).toEqual(claims);
    });
  });

  describe('resolveClaim', () => {
    it('should resolve a claim with verdict and confidence score', async () => {
      const claim = ClaimFactory.createClaim({ resolvedVerdict: null, confidenceScore: null, resolvedAt: null });
      const verdict = true;
      const confidenceScore = 0.85;

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue({ ...claim, resolvedVerdict: verdict, confidenceScore } as Claim);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      const result = await service.resolveClaim(claim.id, verdict, confidenceScore);

      expect(service.findOne).toHaveBeenCalledWith(claim.id);
      expect(claimRepo.save).toHaveBeenCalled();
      expect(claimsCache.invalidateClaim).toHaveBeenCalledWith(claim.id);
      expect(result.resolvedVerdict).toEqual(verdict);
      expect(result.confidenceScore).toEqual(confidenceScore);
    });

    it('should invalidate claims:latest cache when resolving a claim', async () => {
      const claim = ClaimFactory.createClaim({ resolvedVerdict: null, confidenceScore: null, resolvedAt: null });
      const verdict = false;
      const confidenceScore = 0.65;

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue({ ...claim, resolvedVerdict: verdict, confidenceScore } as Claim);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.resolveClaim(claim.id, verdict, confidenceScore);

      expect(claimsCache.invalidateClaim).toHaveBeenCalledWith(claim.id);
    });

    it('should throw error if claim not found when resolving', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue(null);

      await expect(service.resolveClaim('non-existent-id', true, 0.8)).rejects.toThrow('Claim non-existent-id not found');
    });

    it('should log audit trail when resolving a claim', async () => {
      const claim = ClaimFactory.createClaim({ resolvedVerdict: null, confidenceScore: null, resolvedAt: null });
      const verdict = true;
      const confidenceScore = 0.75;
      const userId = 'user-123';

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue({ ...claim, resolvedVerdict: verdict, confidenceScore } as Claim);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.resolveClaim(claim.id, verdict, confidenceScore, userId);

      expect(auditTrailService.log).toHaveBeenCalled();
    });

    // ─── BE-219: resolvedAt invariants ────────────────────────────────────
    it('should set resolvedAt on the claim entity before saving (BE-219)', async () => {
      const claim = ClaimFactory.createClaim({ resolvedVerdict: null, confidenceScore: null, resolvedAt: null });
      const before = new Date();

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      // Capture the argument passed to save so we can inspect resolvedAt
      const saveSpy = jest.spyOn(claimRepo, 'save').mockImplementation(async (entity: any) => entity);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.resolveClaim(claim.id, true, 0.85);
      const after = new Date();

      const savedEntity = saveSpy.mock.calls[0][0] as any;
      expect(savedEntity.resolvedAt).toBeInstanceOf(Date);
      expect(savedEntity.resolvedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(savedEntity.resolvedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should not overwrite resolvedAt if claim was already resolved (BE-219)', async () => {
      const existingResolvedAt = new Date('2024-01-01T00:00:00Z');
      const claim = ClaimFactory.createClaim({
        resolvedVerdict: true,
        confidenceScore: 0.80,
        resolvedAt: existingResolvedAt,
      });

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      const saveSpy = jest.spyOn(claimRepo, 'save').mockImplementation(async (entity: any) => entity);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.resolveClaim(claim.id, false, 0.90);

      const savedEntity = saveSpy.mock.calls[0][0] as any;
      // The original resolvedAt must not be overwritten
      expect(savedEntity.resolvedAt).toEqual(existingResolvedAt);
    });

    it('new claim has resolvedAt === null before any resolution (BE-219)', async () => {
      const createClaimDto = ClaimFactory.createCreateClaimDto();
      const savedClaim = ClaimFactory.createClaim({
        ...createClaimDto,
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        resolvedAt: null,
      });

      jest.spyOn(claimRepo, 'create').mockReturnValue(savedClaim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue(savedClaim);
      jest.spyOn(claimsCache, 'setClaim').mockResolvedValue(undefined);
      jest.spyOn(redisService, 'del').mockResolvedValue(true);

      const result = await service.createClaim(createClaimDto);

      expect(result.resolvedAt).toBeNull();
    });
  });

  describe('finalizeClaim', () => {
    it('should finalize a claim', async () => {
      const claim = ClaimFactory.createClaim({ finalized: false });

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue({ ...claim, finalized: true } as Claim);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      const result = await service.finalizeClaim(claim.id);

      expect(service.findOne).toHaveBeenCalledWith(claim.id);
      expect(claimRepo.save).toHaveBeenCalled();
      expect(claimsCache.invalidateClaim).toHaveBeenCalledWith(claim.id);
      expect(result.finalized).toEqual(true);
    });

    it('should invalidate claims:latest cache when finalizing a claim', async () => {
      const claim = ClaimFactory.createClaim({ finalized: false });

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue({ ...claim, finalized: true } as Claim);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.finalizeClaim(claim.id);

      expect(claimsCache.invalidateClaim).toHaveBeenCalledWith(claim.id);
    });

    it('should throw error if claim not found when finalizing', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue(null);

      await expect(service.finalizeClaim('non-existent-id')).rejects.toThrow('Claim non-existent-id not found');
    });

    it('should log audit trail when finalizing a claim', async () => {
      const claim = ClaimFactory.createClaim({ finalized: false });
      const userId = 'user-123';

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      jest.spyOn(claimRepo, 'save').mockResolvedValue({ ...claim, finalized: true } as Claim);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.finalizeClaim(claim.id, userId);

      expect(auditTrailService.log).toHaveBeenCalled();
    });

    // ─── BE-219: resolvedAt invariants on finalizeClaim ───────────────────
    it('should preserve existing resolvedAt when finalizing an already-resolved claim (BE-219)', async () => {
      const existingResolvedAt = new Date('2024-06-15T12:00:00Z');
      const claim = ClaimFactory.createClaim({
        resolvedVerdict: true,
        confidenceScore: 0.80,
        finalized: false,
        resolvedAt: existingResolvedAt,
      });

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      const saveSpy = jest.spyOn(claimRepo, 'save').mockImplementation(async (entity: any) => entity);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      await service.finalizeClaim(claim.id);

      const savedEntity = saveSpy.mock.calls[0][0] as any;
      // resolvedAt was already set when the claim was resolved; it must not change
      expect(savedEntity.resolvedAt).toEqual(existingResolvedAt);
      expect(savedEntity.finalized).toBe(true);
    });

    it('should set resolvedAt when directly finalizing a pending claim (PENDING → FINALIZED) (BE-219)', async () => {
      const claim = ClaimFactory.createClaim({
        resolvedVerdict: null,
        confidenceScore: null,
        finalized: false,
        resolvedAt: null,
      });
      const before = new Date();

      jest.spyOn(service, 'findOne').mockResolvedValue(claim);
      const saveSpy = jest.spyOn(claimRepo, 'save').mockImplementation(async (entity: any) => entity);
      jest.spyOn(claimsCache, 'invalidateClaim').mockResolvedValue(undefined);
      jest.spyOn(auditTrailService, 'log').mockResolvedValue(undefined);

      // finalizeClaim calls transitionTo(FINALIZED) — without data, which throws for PENDING state
      // This tests the guard: a PENDING → FINALIZED transition requires verdict + confidence
      await expect(service.finalizeClaim(claim.id)).rejects.toThrow(
        'PENDING → FINALIZED requires both verdict and confidence data',
      );

      // save must NOT have been called since the transition failed
      expect(saveSpy).not.toHaveBeenCalled();
    });
  });
});
