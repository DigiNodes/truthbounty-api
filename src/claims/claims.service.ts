import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typorm';
import { Claim, ClaimState } from './entities/claim.entity';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ClaimsCache } from '../cache/claims.cache';
import { RedisService } from '../redis/redis.service';
import { Stake } from '../staking/entities/stake.entity';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';
import { AuditLog } from '../audit/decorators/audit-log.decorator';
import { assertResolvedAtInvariant } from './claim-resolution.invariant';
import { CacheUnavailableException } from '../cache/exceptions/cache-unavailable.exception';
import {
  ClaimBadRequestError,
  ClaimConflictError,
  ClaimInvalidTransitionError,
  ClaimNotFoundError,
  ClaimUnavailableError,
} from './errors/claim-lifecycle.errors';
import {
  CursorService,
  CursorContext,
  PaginationCursorPayload,
} from '../pagination/cursor.service';
import { CursorErrorCode } from '../pagination/cursor.error';
import {
  ClaimPaginationFilters,
  ClaimPaginationSort,
  PaginatedClaimsResult,
} from './claims.pagination.types';
import {
  SecretScannerService,
  SecretScanResult,
} from './secret-scanner.service';
import { SecretQuarantineException } from './exceptions/secret-quarantine.exception';

const CLAIMS_PAGINATION_ROUTE = 'claims.list';
const CLAIMS_PAGINATION_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
    private readonly cursorService: CursorService,
    private readonly secretScannerService: SecretScannerService,
  ) {}

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
        this.logger.warn(
          ` Cache unavailable for claim ${id}, serving from database: ${error.message}`,
        );
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
          this.logger.warn(
            `Cache unavailable for claim ${id}, skipping cache update: ${error.message}`,
          );
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

    // Get claim IFs from user stakes
    const stakes = await this.stakeRepo.find({
      where: { walletAddress: wallet },
    });

    const claimIds = [...new Set(stakes.map((s) => s.claimId))];
    if (claimIds.length === 0) return [];

    const claims = await this.claimRepo
      .createQueryBuilder('claim')
      .where('claim.id IN (:ids)', { ids: claimIds })
      .orderBy('claim.createdAt', 'DESC')
      .getMany();

    try {
      await this.claimsCache.setUserClaims(wallet, claims);
    } catch (error) {
      if (error instanceof CacheUnavailableException) {
        this.logger.warn(
          `Cache unavailable for user claims ${wallet}, skipping cache update: ${error.message}`,
        );
        // Continue - cache failure is isolated from canonical state
      } else {
        throw error;
      }
    }
    return claims;
  }

  /**
   * Paginate claims using an authenticated, opaque cursor.
   *
   * The cursor binds the client-supplied filters, sort order, route/schema,
   * expiry, and release context so clients cannot alter position or filters
   * without detection. Tampering, replay across endpoints, expiry, and
   * key rotation are rejected by the CursorService.
   */
  async paginateClaims(
    filters: ClaimPaginationFilters,
    sort: ClaimPaginationSort,
    cursor: string | undefined,
    pageSize: number | undefined,
  ): Promise<PaginatedClaimsResult> {
    const normalizedFilters = this.normalizeFilters(filters);
    const normalizedSort = this.normalizeSort(sort);
    const effectivePageSize = this.resolvePageSize(pageSize);

    const context: CursorContext = {
      route: CLAIMS_PAGINATION_ROUTE,
      schemaVersion: CLAIMS_PAGINATION_SCHEMA_VERSION,
      filters: normalizedFilters,
      sort: normalizedSort,
    };

    let position: PaginationCursorPayload['position'] | null = null;
    if (cursor) {
      const verified = this.cursorService.verifyCursor(cursor, context);
      position = verified.position;
    }

    const qb = this.claimRepo.createQueryBuilder('claim');

    this.applyFilters(qb, normalizedFilters);

    // Keyset pagination on (createdAt, id) for stable ordering under
    // concurrent inserts. Tuple comparison avoids skips/duplicates when
    // new rows arrive between pages.
    if (position) {
      const operator = normalizedSort.direction === 'ASC' ? '>' : '<';
      qb.andWhere(
        `(claim.createdAt,  claim.id) ${operator} (:cursorCreatedAt, :cursorId)`,
        {
          cursorCreatedAt: position.createdAt,
          cursorId: position.id,
        },
      );
    }

    qb
      .orderBy('claim.createdAt', normalizedSort.direction)
      .addOrderBy('claim.id', normalizedSort.direction)
      .take(effectivePageSize + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > effectivePageSize;
    const items = hasMore ? rows.slice(0, effectivePageSize) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = this.cursorService.issueCursor(context, {
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      });
    }

    return {
      items,
      nextCursor,
      hasMore,
      pageSize: effectivePageSize,
    };
  }

  private normalizeFilters(
    filters: ClaimPaginationFilters | undefined,
  ): Record<string, unknown> {
    const source = filters ?? {};
    const normalized: Record<string, unknown> = {};
    if (source.state !== undefined && source.state !== null) {
      normalized.state = source.state;
    }
    if (source.source !== undefined && source.source !== null) {
      normalized.source = source.source;
    }
    if (source.finalized !== undefined && source.finalized !== null) {
      normalized.finalized = source.finalized;
    }
    return normalized;
  }

  private normalizeSort(
    sort: ClaimPaginationSort | undefined,
  ): ClaimPaginationSort {
    const direction = sort?.direction === 'ASC' ? 'ASC' : 'DESC';
    return { field: 'createdAt', direction };
  }

  private resolvePageSize(pageSize: number | undefined): number {
    if (pageSize === undefined || pageSize === null) {
      return DEFAULT_PAGE_SIZE;
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `Page size must be an integer between 1 and ${MAX_PAGE_SIZE}`,
      );
    }
    return pageSize;
  }

  private applyFilters(
    qb: ReturnType<Repository<Claim>['createQueryBuilder']>,
    filters: Record<string, unknown>,
  ): void {
    if (filters.state !== undefined) {
      qb.andWhere('claim.state = :state', { state: filters.state });
    }
    if (filters.source !== undefined) {
      qb.andWhere('claim.source = :source', { source: filters.source });
    }
    if (filters.finalized !== undefined) {
      qb.andWhere('claim.finalized = :finalized', {
        finalized: filters.finalized,
      });
    }
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
      throw new ClaimBadRequestError( {
        field: 'title',
        reason: 'max_length_exceeded',
        maxLength: 200,
      });
    }
    if (createClaimDto.content && createClaimDto.content.length > 5000) {
      throw new ClaimBadRequestError({
        field: 'content',
        reason: 'max_length_exceeded',
        maxLength: 5000,
      });
    }

    // Scan support submission for secrets before any persistence or forwarding.
    // High-confidence secrets are quarantined and never echoed into logs or errors.
    const scanResult: SecretScanResult = this.secretScannerService.scanSupportSubmission({
      title: createClaimDto.title,
      content: createClaimDto.content,
      metadata: (createClaimDto as any).metadata,
      attachments: (createClaimDto as any).attachments,
    });

    if (scanResult.blocked) {
      // Quarantine access is restricted and audited. Only metadata about the
      // findings (kind/count) -- never the secret material itself -- is recorded.
      await this.auditTrailService.log({
        actionType: AuditActionType.CLAIM_SECRET_QUARANTINED,
        entityType: AuditEntityType.CLAIM,
        entityId: scanResult.quarantineId,
        description: `Support submission quarantined: ${scanResult.findings.length} finding(s), highest confidence ${scanResult.highestConfidence}`,
        afterState: {
          quarantineId: scanResult.quarantineId,
          findingKinds: scanResult.findings.map((f) => f.kind),
        },
      });

      this.logger.warn(
        `Support submission quarantined ${scanResult.quarantineId} with ${scanResult.findings.length} finding(s); secret material withheld.`,
      );

      throw new SecretQuarantineException(scanResult.quarantineId);
    }

    // Check if a claim with the same content already exists
    // This helps prevent duplicates even without idempotency keys
    const existingClaim = await this.claimRepo.findOne({
      where: {
        title: createClaimDto.title,
        content: createClaimDto.content,
        source: createClaimDto.source,
      },
    });

    if (existingClaim) {
      this.logger.log(
        `Duplicate claim detected, returning existing: ${existingClaim.id} - ${existingClaim.title}`,
      );
      return existingClaim;
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
        this.logger.warn(
          `Cache unavailable for new claim ${savedClaim.id}, skipping cache update: ${error.message}`,
        );
        // Continue - cache failure is isolated from canonical state
      } else {
        throw error;
      }
    }

    // Invalidate latest claims cache since we added a new claim (non-critical)
    try {
      await this.redisService.del('claims:latest');
    } catch (error) {
      if (error instanceof CacheUnavailableException) {
        this.logger.warn(
          `Cache unavailable while invalidating latest claims, continuing: ${error.message}`,
        );
        // Continue - cache failure is isolated from canonical state
      } else {
        throw error;
      }
    }

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
    if (!claim) throw new ClaimNotFoundError({ claimId });

    const beforeState = { ...claim };

    // Use transitionTo helper for validated state transition
    // transitionTo sets resolvedAt on the claim entity when first resolved
    try {
      claim.transitionTo(ClaimState.RESOLVED, {
        verdict,
        confidence: confidenceScore,
      });
    } catch (error) {
      // Translate the generic state-machine rejection into a typed,
      // client-safe domain error. We never leak the underlying message.
      throw new ClaimInvalidTransitionError({
        claimId,
        currentState: claim.state,
        targetState: ClaimState.RESOLVED,
      });
    }

    // Guard: reject if the object is somehow in an inconsistent state
    // before we write (e.g. caller mutated fields directly).
    assertResolvedAtInvariant(claim);

    const updatedClaim = await this.claimRepo.save(claim);
    // Invalidate both the claim-specific cache and the latest claims list cache (non-critical)
    try {
      await this.claimsCache.invalidateClaim(claimId);
    } catch (error) {
      if (error instanceof CacheUnavailableException) {
        this.logger.warn(
          `Cache unavailable for claim invalidation ${claimId}, skipping: ${error.message}`,
        );
        // Continue - cache failure is isolated from canonical state
      } else {
        throw error;
      }
    }

    // Log the resolution
    await this.auditTrailService.log( {
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
    if (!claim) throw new ClaimNotFoundError({ claimId });

    const beforeState = { ...claim };

    // Use transitionTo helper for validated state transition
    // transitionTo preserves resolvedAt if already set (RESOLVED → FINALIZED path)
    try {
      claim.transitionTo(ClaimState.FINALIZED);
    } catch (error) {
      throw new ClaimInvalidTransitionError({
        claimId,
        currentState: claim.state,
        targetState: ClaimState.FINALIZED,
      });
    }

    const updatedClaim = await this.claimRepo.save(claim);
    // Invalidate both the claim-specific cache and the latest claims list cache (non-critical)
    try {
      await this.claimsCache.invalidateClaim(claimId);
    } catch (error) {
      if (error instanceof CacheUnavailableException) {
        this.logger.warn(
          `Cache unavailable for claim invalidation ${claimId}, skipping: ${error.message}`,
        );
        // Continue - cache failure is isolated from canonical state
      } else {
        throw error;
      }
    }

    // Log the finalization
    await this.auditTrailService.log( {
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