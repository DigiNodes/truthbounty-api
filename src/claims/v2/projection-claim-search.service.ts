import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In, Like, ILike } from 'typeorm';
import { ClaimRecord } from '../../entities/claim-record.entity';
import { ClaimState } from '../../domain/claim/claimState';
import { CacheKeyRegistryService } from '../../cache/cache-key-registry.service';

export interface ClaimSearchFilters {
  // Text search
  query?: string; // Full-text search on title, description, tags

  // Status filters
  states?: ClaimState[];
  status?: 'open' | 'in_review' | 'verified' | 'rejected' | 'disputed';

  // Chain/contract filters
  chainIds?: number[];
  contractAddresses?: string[];

  // User filters
  submitterAddress?: string;
  verifierAddress?: string;

  // Date range filters
  createdAfter?: Date;
  createdBefore?: Date;
  updatedAfter?: Date;
  updatedBefore?: Date;

  // Amount filters (for reward-bearing claims)
  minReward?: string;
  maxReward?: string;

  // Pagination
  cursor?: string; // Opaque cursor for stable pagination
  limit?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'rewardAmount' | 'reputationScore';
  sortOrder?: 'ASC' | 'DESC';

  // Projection watermark (for consistency)
  projectionWatermark?: string;
}

export interface ClaimSearchResult {
  claims: ClaimRecord[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
  projectionWatermark: string;
  executionTimeMs: number;
}

export interface ClaimSearchCursor {
  lastId: string;
  lastSortValue: any;
  projectionWatermark: string;
}

export interface SearchProjectionSnapshot {
  watermark: string;
  blockNumber: number;
  timestamp: Date;
  claimCount: number;
}

/**
 * Projection-Only Claim Search Service
 *
 * Implements bounded search and filters entirely from read models
 * without querying contracts per request or mutating protocol state.
 *
 * Implements V2-BE-059: Build Projection-Only Claim Search
 */
@Injectable()
export class ProjectionClaimSearchService {
  private readonly logger = new Logger(ProjectionClaimSearchService.name);

  private readonly DEFAULT_LIMIT = 20;
  private readonly MAX_LIMIT = 100;
  private readonly CURSOR_TTL_SECONDS = 300; // 5 minutes

  constructor(
    @InjectRepository(ClaimRecord)
    private readonly claimRepo: Repository<ClaimRecord>,
    private readonly cacheKeyRegistry: CacheKeyRegistryService,
  ) {}

  /**
   * Search claims using only projection data
   */
  async search(filters: ClaimSearchFilters): Promise<ClaimSearchResult> {
    const startTime = Date.now();

    // Get projection watermark for consistency
    const watermark = filters.projectionWatermark || await this.getLatestWatermark();

    // Build cache key
    const cacheKey = this.buildSearchCacheKey(filters, watermark);

    // Try cache first
    const cached = await this.getCachedResults(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for claim search: ${cacheKey}`);
      return cached;
    }

    // Build query from projections only
    const { claims, totalCount, nextCursor } = await this.executeSearch(filters, watermark);

    const result: ClaimSearchResult = {
      claims,
      totalCount,
      hasMore: !!nextCursor,
      nextCursor,
      projectionWatermark: watermark,
      executionTimeMs: Date.now() - startTime,
    };

    // Cache results
    await this.cacheResults(cacheKey, result);

    return result;
  }

  /**
   * Get claim by ID from projection
   */
  async getById(claimId: string): Promise<ClaimRecord | null> {
    return this.claimRepo.findOne({ where: { id: claimId } });
  }

  /**
   * Get claims by submitter with cursor pagination
   */
  async getBySubmitter(
    submitterAddress: string,
    cursor?: string,
    limit = this.DEFAULT_LIMIT,
  ): Promise<ClaimSearchResult> {
    return this.search({
      submitterAddress: submitterAddress.toLowerCase(),
      cursor,
      limit: Math.min(limit, this.MAX_LIMIT),
      sortBy: 'createdAt',
      sortOrder: 'DESC',
    });
  }

  /**
   * Get claims by verifier with cursor pagination
   */
  async getByVerifier(
    verifierAddress: string,
    cursor?: string,
    limit = this.DEFAULT_LIMIT,
  ): Promise<ClaimSearchResult> {
    return this.search({
      verifierAddress: verifierAddress.toLowerCase(),
      cursor,
      limit: Math.min(limit, this.MAX_LIMIT),
      sortBy: 'updatedAt',
      sortOrder: 'DESC',
    });
  }

  /**
   * Get claims by state with cursor pagination
   */
  async getByState(
    state: ClaimState,
    chainIds?: number[],
    cursor?: string,
    limit = this.DEFAULT_LIMIT,
  ): Promise<ClaimSearchResult> {
    return this.search({
      states: [state],
      chainIds,
      cursor,
      limit: Math.min(limit, this.MAX_LIMIT),
      sortBy: 'createdAt',
      sortOrder: 'DESC',
    });
  }

  /**
   * Get claims needing review (moderation queue)
   */
  async getModerationQueue(
    chainIds?: number[],
    cursor?: string,
    limit = this.DEFAULT_LIMIT,
  ): Promise<ClaimSearchResult> {
    return this.search({
      states: [ClaimState.SUBMITTED, ClaimState.UNDER_REVIEW],
      chainIds,
      cursor,
      limit: Math.min(limit, this.MAX_LIMIT),
      sortBy: 'createdAt',
      sortOrder: 'ASC', // Oldest first for moderation
    });
  }

  /**
   * Get latest projection watermark
   */
  async getLatestWatermark(): Promise<string> {
    // In production, this would read from a dedicated projection_watermarks table
    // For now, generate from latest claim block number
    const latestClaim = await this.claimRepo
      .createQueryBuilder('claim')
      .select('MAX(claim.blockNumber)', 'maxBlock')
      .addSelect('MAX(claim.updatedAt)', 'maxUpdated')
      .getRawOne();

    if (latestClaim?.maxBlock) {
      return `claims:v${latestClaim.maxBlock}:${latestClaim.maxUpdated?.getTime() || Date.now()}`;
    }

    return `claims:v0:${Date.now()}`;
  }

  /**
   * Get projection snapshot for consistency
   */
  async getProjectionSnapshot(): Promise<SearchProjectionSnapshot> {
    const watermark = await this.getLatestWatermark();
    const claimCount = await this.claimRepo.count();

    return {
      watermark,
      blockNumber: parseInt(watermark.split(':')[1]?.replace('v', '') || '0', 10),
      timestamp: new Date(),
      claimCount,
    };
  }

  /**
   * Execute search query against projections
   */
  private async executeSearch(
    filters: ClaimSearchFilters,
    watermark: string,
  ): Promise<{ claims: ClaimRecord[]; totalCount: number; nextCursor?: string }> {
    const qb = this.claimRepo.createQueryBuilder('claim');

    // Apply filters
    this.applyFilters(qb, filters);

    // Apply sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    qb.orderBy(`claim.${sortBy}`, sortOrder);

    // Apply cursor-based pagination
    if (filters.cursor) {
      const cursorData = this.decodeCursor(filters.cursor);
      if (cursorData && cursorData.projectionWatermark === watermark) {
        this.applyCursor(qb, cursorData, sortBy, sortOrder);
      }
    }

    // Get total count (without limit)
    const totalCount = await qb.getCount();

    // Apply limit
    const limit = Math.min(filters.limit || this.DEFAULT_LIMIT, this.MAX_LIMIT);
    qb.limit(limit + 1); // +1 to check if there are more

    const claims = await qb.getMany();

    // Check if there are more results
    let nextCursor: string | undefined;
    if (claims.length > limit) {
      claims.pop(); // Remove the extra item
      const lastClaim = claims[claims.length - 1];
      nextCursor = this.encodeCursor({
        lastId: lastClaim.id,
        lastSortValue: lastClaim[sortBy],
        projectionWatermark: watermark,
      });
    }

    return { claims, totalCount, nextCursor };
  }

  /**
   * Apply filters to query builder
   */
  private applyFilters(qb: any, filters: ClaimSearchFilters): void {
    // Text search
    if (filters.query) {
      qb.andWhere(
        '(claim.title ILIKE :query OR claim.description ILIKE :query OR claim.tags ILIKE :query)',
        { query: `%${filters.query}%` },
      );
    }

    // State filters
    if (filters.states && filters.states.length > 0) {
      qb.andWhere('claim.state IN (:...states)', { states: filters.states });
    }

    if (filters.status) {
      const stateMap: Record<string, ClaimState[]> = {
        open: [ClaimState.SUBMITTED, ClaimState.UNDER_REVIEW],
        in_review: [ClaimState.UNDER_REVIEW],
        verified: [ClaimState.VERIFIED],
        rejected: [ClaimState.REJECTED],
        disputed: [ClaimState.DISPUTED],
      };
      const states = stateMap[filters.status];
      if (states) {
        qb.andWhere('claim.state IN (:...states)', { states });
      }
    }

    // Chain/contract filters
    if (filters.chainIds && filters.chainIds.length > 0) {
      qb.andWhere('claim.chainId IN (:...chainIds)', { chainIds: filters.chainIds });
    }

    if (filters.contractAddresses && filters.contractAddresses.length > 0) {
      qb.andWhere('claim.contractAddress IN (:...addresses)', {
        addresses: filters.contractAddresses.map((a) => a.toLowerCase()),
      });
    }

    // User filters
    if (filters.submitterAddress) {
      qb.andWhere('claim.submitterAddress = :submitter', {
        submitter: filters.submitterAddress.toLowerCase(),
      });
    }

    if (filters.verifierAddress) {
      qb.andWhere('claim.verifierAddress = :verifier', {
        verifier: filters.verifierAddress.toLowerCase(),
      });
    }

    // Date range filters
    if (filters.createdAfter) {
      qb.andWhere('claim.createdAt >= :createdAfter', { createdAfter: filters.createdAfter });
    }
    if (filters.createdBefore) {
      qb.andWhere('claim.createdAt <= :createdBefore', { createdBefore: filters.createdBefore });
    }
    if (filters.updatedAfter) {
      qb.andWhere('claim.updatedAt >= :updatedAfter', { updatedAfter: filters.updatedAfter });
    }
    if (filters.updatedBefore) {
      qb.andWhere('claim.updatedAt <= :updatedBefore', { updatedBefore: filters.updatedBefore });
    }

    // Amount filters
    if (filters.minReward) {
      qb.andWhere('claim.rewardAmount >= :minReward', { minReward: filters.minReward });
    }
    if (filters.maxReward) {
      qb.andWhere('claim.rewardAmount <= :maxReward', { maxReward: filters.maxReward });
    }
  }

  /**
   * Apply cursor pagination
   */
  private applyCursor(qb: any, cursor: ClaimSearchCursor, sortBy: string, sortOrder: string): void {
    const operator = sortOrder === 'ASC' ? '>' : '<';
    const sortValue = cursor.lastSortValue;

    if (sortBy === 'createdAt' || sortBy === 'updatedAt') {
      qb.andWhere(`claim.${sortBy} ${operator} :cursorValue`, { cursorValue: new Date(sortValue) });
    } else {
      qb.andWhere(`claim.${sortBy} ${operator} :cursorValue`, { cursorValue: sortValue });
    }

    // Tiebreaker on ID for stable pagination
    qb.andWhere(`(claim.${sortBy} ${operator} :cursorValue OR (claim.${sortBy} = :cursorValue AND claim.id > :lastId))`, {
      cursorValue: sortValue,
      lastId: cursor.lastId,
    });
  }

  /**
   * Build cache key for search
   */
  private buildSearchCacheKey(filters: ClaimSearchFilters, watermark: string): string {
    const keyParts = ['search:claims'];

    if (filters.query) keyParts.push(`q:${this.hashString(filters.query)}`);
    if (filters.states) keyParts.push(`s:${filters.states.sort().join(',')}`);
    if (filters.status) keyParts.push(`st:${filters.status}`);
    if (filters.chainIds) keyParts.push(`c:${filters.chainIds.sort().join(',')}`);
    if (filters.contractAddresses) keyParts.push(`ca:${filters.contractAddresses.sort().join(',')}`);
    if (filters.submitterAddress) keyParts.push(`sa:${filters.submitterAddress}`);
    if (filters.verifierAddress) keyParts.push(`va:${filters.verifierAddress}`);
    if (filters.cursor) keyParts.push(`cur:${filters.cursor}`);
    if (filters.limit) keyParts.push(`l:${filters.limit}`);
    if (filters.sortBy) keyParts.push(`sb:${filters.sortBy}:${filters.sortOrder || 'DESC'}`);

    keyParts.push(`wm:${watermark}`);

    return keyParts.join(':');
  }

  /**
   * Get cached search results
   */
  private async getCachedResults(cacheKey: string): Promise<ClaimSearchResult | null> {
    // In production, use Redis GET
    // For now, return null (cache miss)
    return null;
  }

  /**
   * Cache search results
   */
  private async cacheResults(cacheKey: string, result: ClaimSearchResult): Promise<void> {
    // In production, use Redis SET with TTL
    this.logger.debug(`Cached search results for: ${cacheKey}`);
  }

  /**
   * Encode cursor for pagination
   */
  private encodeCursor(cursor: ClaimSearchCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  /**
   * Decode cursor for pagination
   */
  private decodeCursor(cursor: string): ClaimSearchCursor | null {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64url').toString());
    } catch {
      return null;
    }
  }

  /**
   * Simple hash for cache key components
   */
  private hashString(str: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}