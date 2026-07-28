import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder, Brackets } from 'typeorm';
import { Claim } from '../claims/entities/claim.entity';
import { Dispute } from '../dispute/entities/dispute.entity';
import { User } from '../entities/user.entity';
import { RedisService } from '../redis/redis.service';
import {
  GlobalSearchResult,
  PaginationParams,
  SearchableEntity,
  SearchFilter,
  SearchResult,
  SortField,
} from './search.types';

const CACHE_TTL_SECONDS = 30;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    @InjectRepository(Dispute)
    private readonly disputeRepo: Repository<Dispute>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly redisService: RedisService,
  ) {}

  async searchGlobal(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<GlobalSearchResult> {
    const cacheKey = this.globalCacheKey(query, filters, pagination, sort);
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as GlobalSearchResult;
      } catch {
        // fall through
      }
    }

    const [claims, disputes, users] = await Promise.all([
      this.searchClaims(query, filters, pagination, sort),
      this.searchDisputes(query, filters, pagination, sort),
      this.searchUsers(query, filters, pagination, sort),
    ]);

    const result: GlobalSearchResult = {
      query,
      claims,
      disputes,
      users,
    };

    await this.redisService.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    return result;
  }

  async searchEntity(
    entity: SearchableEntity,
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<unknown>> {
    switch (entity) {
      case 'claims':
        return this.searchClaims(query, filters, pagination, sort);
      case 'disputes':
        return this.searchDisputes(query, filters, pagination, sort);
      case 'users':
        return this.searchUsers(query, filters, pagination, sort);
      default:
        throw new BadRequestException(`Unknown entity: ${entity}`);
    }
  }

  private async searchClaims(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<Claim>> {
    const qb = this.claimRepo.createQueryBuilder('claim');

    if (query) {
      const likeQuery = `%${query}%`;
      qb.andWhere(
        new Brackets((sub) => {
          sub.where('claim.title LIKE :q', { q: likeQuery });
          sub.orWhere('claim.content LIKE :q', { q: likeQuery });
          sub.orWhere('claim.source LIKE :q', { q: likeQuery });
        }),
      );
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
    return this.executeOffsetPagination(qb, pagination);
  }

  private async searchDisputes(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<Dispute>> {
    const qb = this.disputeRepo.createQueryBuilder('dispute');

    if (query) {
      const likeQuery = `%${query}%`;
      qb.andWhere(
        new Brackets((sub) => {
          sub.where('dispute.status LIKE :q', { q: likeQuery });
          sub.orWhere('dispute.trigger LIKE :q', { q: likeQuery });
        }),
      );
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
    return this.executeOffsetPagination(qb, pagination);
  }

  private async searchUsers(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): Promise<SearchResult<User>> {
    const qb = this.userRepo.createQueryBuilder('user');

    if (query) {
      qb.andWhere('user.walletAddress LIKE :q', { q: `%${query}%` });
    }

    if (filters.walletAddress) {
      qb.andWhere('user.walletAddress = :walletAddress', {
        walletAddress: filters.walletAddress,
      });
    }

    if (sort === 'reputation') {
      qb.orderBy('user.reputation', 'DESC');
    } else {
      this.applySorting(qb, sort, 'user');
    }

    return this.executeOffsetPagination(qb, pagination);
  }

  private applySorting<T extends Record<string, any>>(
    qb: SelectQueryBuilder<T>,
    sort: SortField,
    alias: string,
  ): void {
    switch (sort) {
      case 'oldest':
        qb.orderBy(`${alias}.createdAt`, 'ASC');
        break;
      case 'relevance':
      case 'reward':
      case 'newest':
      default:
        qb.orderBy(`${alias}.createdAt`, 'DESC');
        break;
    }
  }

  private async executeOffsetPagination<T extends Record<string, any>>(
    qb: SelectQueryBuilder<T>,
    pagination: PaginationParams,
  ): Promise<SearchResult<T>> {
    const page = Math.max(1, pagination.page);
    const limit = Math.min(100, Math.max(1, pagination.limit));
    const skip = (page - 1) * limit;

    const [data, total] = await qb.skip(skip).take(limit).getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private globalCacheKey(
    query: string,
    filters: SearchFilter,
    pagination: PaginationParams,
    sort: SortField,
  ): string {
    return `search:global:${query}:${JSON.stringify(filters)}:${sort}:${pagination.page}:${pagination.limit}`;
  }
}
