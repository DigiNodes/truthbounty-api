import {
  Injectable,
  Logger,
  BadRequestException,
  RequestTimeoutException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder, Brackets } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Claim } from '../claims/entities/claim.entity';
import { Dispute } from '../dispute/entities/dispute.entity';
import { User } from '../entities/user.entity';
import { RedisService } from '../redis/redis.service';
import {
  GlobalSearchResult,
  PaginationParams,
  PaginationType,
  PublicUserResult,
  SearchableEntity,
  SearchFilter,
  SearchResult,
  SortField,
} from './search.types';
import {
  validateAndSanitizeQuery,
  validateFilters,
  validateSort,
  validatePagination,
  escapeLike,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  SanitizedQuery,
} from './search.complexity';
import { StableCursorUtil } from '../pagination/stable-cursor';

const CACHE_TTL_SECONDS = 30;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly timeoutMs: number;

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    @InjectRepository(Dispute)
    private readonly disputeRepo: Repository<Dispute>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly redisService: RedisService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {
    this.timeoutMs =
      this.configService?.get<number>(
        'SEARCH_TIMEOUT_MS',
        DEFAULT_SEARCH_TIMEOUT_MS,
      ) ?? DEFAULT_SEARCH_TIMEOUT_MS;
  }

  async searchGlobal(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
    options?: { timeoutMs?: number },
  ): Promise<GlobalSearchResult> {
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    return this.withTimeout(
      this.executeSearchGlobal(query, filters, pagination, sort),
      timeout,
    );
  }

  private async executeSearchGlobal(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<GlobalSearchResult> {
    // Validate inputs
    const sanitizedQuery = validateAndSanitizeQuery(query, 'global');
    validateFilters('global', filters);
    validateSort('global', sort);
    validatePagination(pagination);

    const cacheKey = this.globalCacheKey(sanitizedQuery.normalized, filters, pagination, sort);
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as GlobalSearchResult;
      } catch {
        // fall through
      }
    }

    const [claims, disputes, users] = await Promise.all([
      this.searchClaims(sanitizedQuery, filters, pagination, sort),
      this.searchDisputes(sanitizedQuery, filters, pagination, sort),
      this.searchUsers(sanitizedQuery, filters, pagination, sort),
    ]);

    const result: GlobalSearchResult = {
      query: sanitizedQuery.normalized,
      claims,
      disputes,
      users,
    };

    await this.redisService.set(
      cacheKey,
      JSON.stringify(result),
      CACHE_TTL_SECONDS,
    );
    return result;
  }

  async searchEntity(
    entity: SearchableEntity,
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
    options?: { timeoutMs?: number },
  ): Promise<SearchResult<unknown>> {
    const timeout = options?.timeoutMs ?? this.timeoutMs;
    return this.withTimeout(
      this.executeSearchEntity(entity, query, filters, pagination, sort),
      timeout,
    );
  }

  private async executeSearchEntity(
    entity: SearchableEntity,
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<unknown>> {
    if (!['claims', 'disputes', 'users'].includes(entity)) {
      throw new BadRequestException(`Unknown entity: ${String(entity)}`);
    }

    const sanitizedQuery = validateAndSanitizeQuery(query, entity);
    validateFilters(entity, filters);
    validateSort(entity, sort);
    validatePagination(pagination);

    switch (entity) {
      case 'claims':
        return this.searchClaims(sanitizedQuery, filters, pagination, sort);
      case 'disputes':
        return this.searchDisputes(sanitizedQuery, filters, pagination, sort);
      case 'users':
        return this.searchUsers(sanitizedQuery, filters, pagination, sort);
      default:
        throw new BadRequestException(`Unknown entity: ${String(entity)}`);
    }
  }

  private async searchClaims(
    sanitizedQuery: SanitizedQuery,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<Claim>> {
    const qb = this.claimRepo.createQueryBuilder('claim');

    if (sanitizedQuery.terms.length > 0) {
      for (let i = 0; i < sanitizedQuery.terms.length; i++) {
        const term = sanitizedQuery.terms[i];
        const escaped = escapeLike(term);
        const param = `qc_${i}`;
        qb.andWhere(
          new Brackets((sub) => {
            sub.where(`claim.title LIKE :${param} ESCAPE '\\'`, { [param]: `%${escaped}%` });
            sub.orWhere(`claim.content LIKE :${param} ESCAPE '\\'`, { [param]: `%${escaped}%` });
            sub.orWhere(`claim.source LIKE :${param} ESCAPE '\\'`, { [param]: `%${escaped}%` });
          }),
        );
      }
    }

    // Handle field-specific terms (e.g. status:PENDING)
    if (sanitizedQuery.fieldTerms.has('status')) {
      qb.andWhere('claim.status = :claimStatusTerm', {
        claimStatusTerm: sanitizedQuery.fieldTerms.get('status'),
      });
    }
    if (sanitizedQuery.fieldTerms.has('finalized')) {
      const val = sanitizedQuery.fieldTerms.get('finalized') === 'true';
      qb.andWhere('claim.finalized = :claimFinalizedTerm', {
        claimFinalizedTerm: val,
      });
    }

    if (filters.finalized !== undefined) {
      qb.andWhere('claim.finalized = :finalized', {
        finalized: filters.finalized,
      });
    }

    if (filters.fromDate) {
      qb.andWhere('claim.createdAt >= :fromDate', {
        fromDate: new Date(filters.fromDate),
      });
    }

    if (filters.toDate) {
      qb.andWhere('claim.createdAt <= :toDate', {
        toDate: new Date(filters.toDate),
      });
    }

    this.applySorting(qb, sort, 'claim');
    return this.executePagination(qb, pagination, sort, 'claim', 'id');
  }

  private async searchDisputes(
    sanitizedQuery: SanitizedQuery,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<Dispute>> {
    const qb = this.disputeRepo.createQueryBuilder('dispute');

    if (sanitizedQuery.terms.length > 0) {
      for (let i = 0; i < sanitizedQuery.terms.length; i++) {
        const term = sanitizedQuery.terms[i];
        const escaped = escapeLike(term);
        const param = `qd_${i}`;
        qb.andWhere(
          new Brackets((sub) => {
            sub.where(`dispute.status LIKE :${param} ESCAPE '\\'`, { [param]: `%${escaped}%` });
            sub.orWhere(`dispute.trigger LIKE :${param} ESCAPE '\\'`, { [param]: `%${escaped}%` });
          }),
        );
      }
    }

    if (sanitizedQuery.fieldTerms.has('status')) {
      qb.andWhere('dispute.status = :disputeStatusTerm', {
        disputeStatusTerm: sanitizedQuery.fieldTerms.get('status'),
      });
    }
    if (sanitizedQuery.fieldTerms.has('trigger')) {
      qb.andWhere('dispute.trigger = :disputeTriggerTerm', {
        disputeTriggerTerm: sanitizedQuery.fieldTerms.get('trigger'),
      });
    }

    if (filters.status) {
      qb.andWhere('dispute.status = :status', { status: filters.status });
    }

    if (filters.fromDate) {
      qb.andWhere('dispute.createdAt >= :fromDate', {
        fromDate: new Date(filters.fromDate),
      });
    }

    if (filters.toDate) {
      qb.andWhere('dispute.createdAt <= :toDate', {
        toDate: new Date(filters.toDate),
      });
    }

    this.applySorting(qb, sort, 'dispute');
    return this.executePagination(qb, pagination, sort, 'dispute', 'id');
  }

  private async searchUsers(
    sanitizedQuery: SanitizedQuery,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<PublicUserResult>> {
    const qb = this.userRepo.createQueryBuilder('user');

    // Only select approved public fields, never private ones like role or wallets
    qb.select([
      'user.id',
      'user.walletAddress',
      'user.reputation',
      'user.worldcoinVerified',
      'user.createdAt',
      'user.updatedAt',
    ]);

    if (sanitizedQuery.terms.length > 0) {
      for (let i = 0; i < sanitizedQuery.terms.length; i++) {
        const term = sanitizedQuery.terms[i];
        const escaped = escapeLike(term);
        const param = `qu_${i}`;
        qb.andWhere(`user.walletAddress LIKE :${param} ESCAPE '\\'`, { [param]: `%${escaped}%` });
      }
    }

    if (sanitizedQuery.fieldTerms.has('walletAddress')) {
      qb.andWhere('user.walletAddress = :userWalletTerm', {
        userWalletTerm: sanitizedQuery.fieldTerms.get('walletAddress'),
      });
    }

    if (filters.walletAddress) {
      qb.andWhere('user.walletAddress = :walletAddress', {
        walletAddress: filters.walletAddress,
      });
    }

    if ((sort as string) === 'reputation') {
      // Deterministic tie-breaker: user.walletAddress ASC
      qb.orderBy('user.reputation', 'DESC').addOrderBy('user.walletAddress', 'ASC');
    } else {
      this.applySorting(qb, sort, 'user');
    }

    const rawResult = await this.executePagination<User>(
      qb,
      pagination,
      sort,
      'user',
      'walletAddress',
    );

    return {
      ...rawResult,
      data: rawResult.data.map((u) => this.sanitizeUser(u)),
    };
  }

  private sanitizeUser(user: User): PublicUserResult {
    return {
      id: user.id,
      walletAddress: user.walletAddress,
      reputation: user.reputation,
      worldcoinVerified: user.worldcoinVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Applies primary sort with a canonical deterministic tie-breaker.
   */
  private applySorting<T extends Record<string, any>>(
    qb: SelectQueryBuilder<T>,
    sort: SortField,
    alias: string,
  ): void {
    const sortValue = sort as string;
    const tieBreaker = alias === 'user' ? `${alias}.walletAddress` : `${alias}.id`;

    switch (sortValue) {
      case 'oldest':
        qb.orderBy(`${alias}.createdAt`, 'ASC').addOrderBy(tieBreaker, 'ASC');
        break;
      case 'relevance':
      case 'reward':
      case 'newest':
      default:
        qb.orderBy(`${alias}.createdAt`, 'DESC').addOrderBy(tieBreaker, 'ASC');
        break;
    }
  }

  private async executePagination<T extends Record<string, any>>(
    qb: SelectQueryBuilder<T>,
    pagination: PaginationParams,
    sort: SortField,
    alias: string,
    tieBreakerField: string = 'id',
  ): Promise<SearchResult<T>> {
    if (pagination.type === PaginationType.CURSOR) {
      return this.executeCursorPagination(qb, pagination, sort, alias, tieBreakerField);
    }
    return this.executeOffsetPagination(qb, pagination);
  }

  private async executeOffsetPagination<T extends Record<string, any>>(
    qb: SelectQueryBuilder<T>,
    pagination: PaginationParams,
  ): Promise<SearchResult<T>> {
    const page = Math.max(1, pagination.page || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, pagination.limit || 20));
    const skip = (page - 1) * limit;

    // Bounded result window depth
    if (skip + limit > MAX_RESULT_WINDOW) {
      throw new BadRequestException(
        `Search result window exceeds maximum depth of ${MAX_RESULT_WINDOW}. Please narrow your search query or use cursor-based pagination.`,
      );
    }

    const [data, total] = await qb.skip(skip).take(limit).getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async executeCursorPagination<T extends Record<string, any>>(
    qb: SelectQueryBuilder<T>,
    pagination: PaginationParams,
    sort: SortField,
    alias: string,
    tieBreakerField: string,
  ): Promise<SearchResult<T>> {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, pagination.limit || 20));

    if (pagination.cursor) {
      const decoded = StableCursorUtil.decode(pagination.cursor);
      if (!decoded) {
        throw new BadRequestException('Invalid pagination cursor');
      }

      const sortDir = decoded.sortDirection;
      const tieBreaker = decoded.tieBreaker;
      const cursorCreatedAt = decoded.createdAt ? new Date(decoded.createdAt) : null;

      if (sort === SortField.REPUTATION && alias === 'user') {
        const lastRep = Number(decoded.sortField === 'reputation' ? (decoded as any).sortValue ?? decoded.createdAt : 0);
        if (sortDir === 'DESC') {
          qb.andWhere(
            `(${alias}.reputation < :lastRep OR (${alias}.reputation = :lastRep AND ${alias}.${tieBreakerField} > :tieBreaker))`,
            { lastRep, tieBreaker },
          );
        } else {
          qb.andWhere(
            `(${alias}.reputation > :lastRep OR (${alias}.reputation = :lastRep AND ${alias}.${tieBreakerField} > :tieBreaker))`,
            { lastRep, tieBreaker },
          );
        }
      } else if (cursorCreatedAt) {
        if (sort === SortField.OLDEST) {
          qb.andWhere(
            `(${alias}.createdAt > :cursorCreatedAt OR (${alias}.createdAt = :cursorCreatedAt AND ${alias}.${tieBreakerField} > :tieBreaker))`,
            { cursorCreatedAt, tieBreaker },
          );
        } else {
          qb.andWhere(
            `(${alias}.createdAt < :cursorCreatedAt OR (${alias}.createdAt = :cursorCreatedAt AND ${alias}.${tieBreakerField} > :tieBreaker))`,
            { cursorCreatedAt, tieBreaker },
          );
        }
      }
    }

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | undefined;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1];
      const sortDir = sort === SortField.OLDEST ? 'ASC' : 'DESC';
      const sortFieldStr = sort === SortField.REPUTATION ? 'reputation' : 'createdAt';
      const lastCreatedAt =
        last.createdAt instanceof Date
          ? last.createdAt.getTime()
          : new Date(last.createdAt || 0).getTime();
      const tieBreakerVal = last[tieBreakerField];

      const cursorObj = StableCursorUtil.createFromValues(
        sortFieldStr,
        sortDir,
        sort === SortField.REPUTATION ? (last as any).reputation : lastCreatedAt,
        tieBreakerVal,
      );
      nextCursor = StableCursorUtil.encode(cursorObj);
    }

    return {
      data,
      total: data.length,
      page: pagination.page || 1,
      limit,
      totalPages: hasMore ? (pagination.page || 1) + 1 : (pagination.page || 1),
      nextCursor,
    };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RequestTimeoutException('Search query execution timed out'));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private globalCacheKey(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): string {
    return `search:global:${query}:${JSON.stringify(filters)}:${String(sort)}:${pagination.page}:${pagination.limit}`;
  }
}
