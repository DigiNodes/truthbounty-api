import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Claim } from './entities/claim.entity';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ClaimsCache } from '../cache/claims.cache';
import { RedisService } from '../redis/redis.service';
import { Stake } from '../staking/entities/stake.entity';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';
import { AuditLog } from '../audit/decorators/audit-log.decorator';


@Injectable()
export class ClaimsService {
    private readonly logger = new Logger(ClaimsService.name);

    constructor(
        @InjectRepository(Claim)
        private readonly claimRepo: Repository<Claim>,
        @InjectRepository(Stake)
        private readonly stakeRepo: Repository<Stake>,
        private readonly claimsCache: ClaimsCache,
        private readonly redisService: RedisService,
        private readonly auditTrailService: AuditTrailService,
    ) { }

    /**
     * Find a single claim by ID with caching
     */
    async findOne(id: string): Promise<Claim | null> {
        const cached = await this.claimsCache.getClaim(id);
        if (cached) return cached;

        const claim = await this.claimRepo.findOneBy({ id });
        if (claim) {
            await this.claimsCache.setClaim(id, claim);
        }
        return claim;
    }

    /**
     * Find latest claims with caching
     */
    async findLatest(limit = 10): Promise<Claim[]> {
        const cached = await this.claimsCache.getLatestClaims();
        if (cached) return cached;

        const claims = await this.claimRepo.find({
            order: { createdAt: 'DESC' },
            take: limit,
        });

        await this.claimsCache.setLatestClaims(claims);
        return claims;
    }

    /**
     * Find claims associated with a user wallet with caching
     */
    async findByUser(wallet: string): Promise<Claim[]> {
        const cached = await this.claimsCache.getUserClaims(wallet);
        if (cached) return cached;

        // Get claim IDs from user stakes
        const stakes = await this.stakeRepo.find({
            where: { walletAddress: wallet },
        });

        const claimIds = [...new Set(stakes.map(s => s.claimId))];
        if (claimIds.length === 0) return [];

        const claims = await this.claimRepo.createQueryBuilder('claim')
            .where('claim.id IN (:...ids)', { ids: claimIds })
            .orderBy('claim.createdAt', 'DESC')
            .getMany();

        await this.claimsCache.setUserClaims(wallet, claims);
        return claims;
    }

    /**
     * Create a new claim
     */
    @AuditLog({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        descriptionTemplate: 'New claim created: {{title}}',
        captureAfterState: true,
    })
    async createClaim(createClaimDto: CreateClaimDto): Promise<Claim> {
        if (createClaimDto.title && createClaimDto.title.length > 200) {
            throw new BadRequestException('Claim title exceeds maximum length of 200 characters');
        }
        if (createClaimDto.content && createClaimDto.content.length > 5000) {
            throw new BadRequestException('Claim content exceeds maximum length of 5000 characters');
        }
        const claim = this.claimRepo.create({
            title: createClaimDto.title,
            content: createClaimDto.content,
            source: createClaimDto.source ?? null,
            metadata: createClaimDto.metadata ?? null,
            resolvedVerdict: null, // Will be computed later
            confidenceScore: null, // Will be computed later
            finalized: false,
        });
        const savedClaim = await this.claimRepo.save(claim);

        // Cache the new claim
        await this.claimsCache.setClaim(savedClaim.id, savedClaim);

        // Invalidate latest claims cache since we added a new claim
        await this.redisService.del('claims:latest');

        this.logger.log(`Created new claim: ${savedClaim.id} - ${savedClaim.title}`);
        return savedClaim;
    }

    /**
     * Resolve a claim (update verdict and confidence)
     */
    async resolveClaim(
        claimId: string,
        verdict: boolean,
        confidenceScore: number,
        userId?: string,
    ): Promise<Claim> {
        const claim = await this.findOne(claimId);
        if (!claim) throw new Error(`Claim ${claimId} not found`);

        const beforeState = { ...claim };

        claim.resolvedVerdict = verdict;
        claim.confidenceScore = confidenceScore;

        const updatedClaim = await this.claimRepo.save(claim);
        // Invalidate both the claim-specific cache and the latest claims list cache
        await this.claimsCache.invalidateClaim(claimId);

        // Log the resolution
        await this.auditTrailService.log({
            actionType: AuditActionType.CLAIM_RESOLVED,
            entityType: AuditEntityType.CLAIM,
            entityId: claimId,
            userId,
            description: `Claim resolved with verdict: ${verdict}, confidence: ${confidenceScore}`,
            beforeState,
            afterState: updatedClaim,
        });

        return updatedClaim;
    }

    /**
     * Finalize a claim
     */
    async finalizeClaim(claimId: string, userId?: string): Promise<Claim> {
        const claim = await this.findOne(claimId);
        if (!claim) throw new Error(`Claim ${claimId} not found`);

        const beforeState = { ...claim };

        claim.finalized = true;
        const updatedClaim = await this.claimRepo.save(claim);
        // Invalidate both the claim-specific cache and the latest claims list cache
        await this.claimsCache.invalidateClaim(claimId);

        // Log the finalization
        await this.auditTrailService.log({
            actionType: AuditActionType.CLAIM_FINALIZED,
            entityType: AuditEntityType.CLAIM,
            entityId: claimId,
            userId,
            description: 'Claim finalized',
            beforeState,
            afterState: updatedClaim,
        });

        return updatedClaim;
    }
}

