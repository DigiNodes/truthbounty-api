import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Claim, ClaimState } from './entities/claim.entity';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ClaimsCache } from '../cache/claims.cache';
import { RedisService } from '../redis/redis.service';
import { Stake } from '../staking/entities/stake.entity';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';
import { AuditLog } from '../audit/decorators/audit-log.decorator';
import {
  assertResolvedAtInvariant,
  buildResolvedFields,
} from './claim-resolution.invariant';
import { CacheUnavailableException } from '../cache/exceptions/cache-unavailable.exception';


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
     * Cache failures are logged and reported, but canonical state (DB) is always served
     */
    async findOne(id: string): Promise<Claim | null> {
        try {
            const cached = await this.claimsCache.getClaim(id);
            if (cached) return cached;
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for claim ${id}, serving from database: ${error.message}`);
                // Fall through to database fetch - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }

        const claim = await this.claimRepo.findOneBy({ id });
        if (claim) {
            try {
                await this.claimsCache.setClaim(id, claim);
            } catch (error) {
                if (error instanceof CacheUnavailableException) {
                    this.logger.warn(`Cache unavailable for claim ${id}, skipping cache update: ${error.message}`);
                    // Continue - cache failure is isolated from canonical state
                } else {
                    throw error;
                }
            }
        }
        return claim;
    }

    /**
     * Find latest claims with caching
     * Cache failures are logged and reported, but canonical state (DB) is always served
     */
    async findLatest(limit = 10): Promise<Claim[]> {
        try {
            const cached = await this.claimsCache.getLatestClaims();
            if (cached) return cached;
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for latest claims, serving from database: ${error.message}`);
                // Fall through to database fetch - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }

        const claims = await this.claimRepo.find({
            order: { createdAt: 'DESC' },
            take: limit,
        });

        try {
            await this.claimsCache.setLatestClaims(claims);
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for latest claims, skipping cache update: ${error.message}`);
                // Continue - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }
        return claims;
    }

    /**
     * Find claims associated with a user wallet with caching
     * Cache failures are logged and reported, but canonical state (DB) is always served
     */
    async findByUser(wallet: string): Promise<Claim[]> {
        try {
            const cached = await this.claimsCache.getUserClaims(wallet);
            if (cached) return cached;
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for user claims ${wallet}, serving from database: ${error.message}`);
                // Fall through to database fetch - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }

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

        try {
            await this.claimsCache.setUserClaims(wallet, claims);
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for user claims ${wallet}, skipping cache update: ${error.message}`);
                // Continue - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }
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

        // Cache the new claim (non-critical - failure is isolated)
        try {
            await this.claimsCache.setClaim(savedClaim.id, savedClaim);
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for new claim ${savedClaim.id}, skipping cache update: ${error.message}`);
                // Continue - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }

        // Invalidate latest claims cache since we added a new claim (non-critical)
        try {
            await this.redisService.del('claims:latest');
        } catch (error) {
            this.logger.warn(`Failed to invalidate latest claims cache: ${error}`);
            // Continue - cache failure is isolated from canonical state
        }

        this.logger.log(`Created new claim: ${savedClaim.id} - ${savedClaim.title}`);
        return savedClaim;
    }

    /**
     * Resolve a claim (update verdict and confidence)
     * Uses state machine validation to ensure valid transitions
     */
    async resolveClaim(
        claimId: string,
        verdict: boolean,
        confidenceScore: number,
        userId?: string,
    ): Promise<Claim> {
        const claim = await this.findOne(claimId);
        if (!claim) throw new NotFoundException(`Claim ${claimId} not found`);

        const beforeState = { ...claim };

        // Use transitionTo helper for validated state transition
        // transitionTo sets resolvedAt on the claim entity when first resolved
        claim.transitionTo(ClaimState.RESOLVED, {
            verdict,
            confidence: confidenceScore,
        });

        // Guard: reject if the object is somehow in an inconsistent state
        // before we write (e.g. caller mutated fields directly).
        assertResolvedAtInvariant(claim);

        const updatedClaim = await this.claimRepo.save(claim);
        // Invalidate both the claim-specific cache and the latest claims list cache (non-critical)
        try {
            await this.claimsCache.invalidateClaim(claimId);
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for claim invalidation ${claimId}, skipping: ${error.message}`);
                // Continue - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }

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
     * Uses state machine validation to ensure valid transitions
     */
    async finalizeClaim(claimId: string, userId?: string): Promise<Claim> {
        const claim = await this.findOne(claimId);
        if (!claim) throw new Error(`Claim ${claimId} not found`);

        const beforeState = { ...claim };

        // Use transitionTo helper for validated state transition
        // transitionTo preserves resolvedAt if already set (RESOLVED → FINALIZED path)
        claim.transitionTo(ClaimState.FINALIZED);

        const updatedClaim = await this.claimRepo.save(claim);
        // Invalidate both the claim-specific cache and the latest claims list cache (non-critical)
        try {
            await this.claimsCache.invalidateClaim(claimId);
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for claim invalidation ${claimId}, skipping: ${error.message}`);
                // Continue - cache failure is isolated from canonical state
            } else {
                throw error;
            }
        }

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

