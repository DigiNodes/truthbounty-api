import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ReputationRecord,
  ReputationEvent,
  ReputationEventType,
} from './entities/reputation.entity';
import { ReputationCache } from './reputation.cache';

export interface FindReputationsDto {
  walletAddress?: string;
  minScore?: number;
  maxScore?: number;
  page?: number;
  pageSize?: number;
  sort?: 'highest' | 'newest' | 'most_active' | 'highest_rewards';
}

export interface PaginatedReputations {
  items: ReputationRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface LeaderboardEntry {
  rank: number;
  walletAddress: string;
  score: number;
  verificationCount: number;
  governanceParticipation: number;
  rewardTotal: number;
}

export interface ReputationStats {
  totalUsers: number;
  averageScore: number;
  highestScore: number;
  totalVerifications: number;
  totalDisputes: number;
}

@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  constructor(
    @InjectRepository(ReputationRecord)
    private readonly reputationRepository: Repository<ReputationRecord>,
    @InjectRepository(ReputationEvent)
    private readonly eventRepository: Repository<ReputationEvent>,
    private readonly reputationCache: ReputationCache,
  ) {}

  // ─── Reputation Retrieval ─────────────────────────────────────────────

  async findByWallet(wallet: string): Promise<ReputationRecord | null> {
    const cached = await this.reputationCache.getUserReputation(wallet);
    if (cached) return cached;

    const record = await this.reputationRepository.findOne({
      where: { walletAddress: wallet.toLowerCase() },
    });

    if (record) {
      await this.reputationCache.setUserReputation(wallet, record);
    }
    return record;
  }

  async findByWalletOrThrow(wallet: string): Promise<ReputationRecord> {
    const record = await this.findByWallet(wallet);
    if (!record) {
      throw new NotFoundException(
        `Reputation record not found for wallet ${wallet}`,
      );
    }
    return record;
  }

  async findMany(wallets: string[]): Promise<ReputationRecord[]> {
    if (wallets.length === 0) return [];

    const records = await this.reputationRepository
      .createQueryBuilder('r')
      .where('r.walletAddress IN (:...wallets)', {
        wallets: wallets.map((w) => w.toLowerCase()),
      })
      .getMany();

    return records;
  }

  async findAll(dto: FindReputationsDto = {}): Promise<PaginatedReputations> {
    const {
      walletAddress,
      minScore,
      maxScore,
      page = 1,
      pageSize = 50,
      sort = 'highest',
    } = dto;

    if (pageSize < 1 || pageSize > 100) {
      throw new BadRequestException('pageSize must be between 1 and 100');
    }
    if (page < 1) {
      throw new BadRequestException('page must be at least 1');
    }

    const qb = this.reputationRepository
      .createQueryBuilder('r')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (walletAddress) {
      qb.andWhere('r.walletAddress = :walletAddress', {
        walletAddress: walletAddress.toLowerCase(),
      });
    }
    if (minScore !== undefined) {
      qb.andWhere('r.score >= :minScore', { minScore });
    }
    if (maxScore !== undefined) {
      qb.andWhere('r.score <= :maxScore', { maxScore });
    }

    switch (sort) {
      case 'newest':
        qb.orderBy('r.createdAt', 'DESC');
        break;
      case 'most_active':
        qb.orderBy('r.verificationCount', 'DESC');
        break;
      case 'highest_rewards':
        qb.orderBy('r.rewardTotal', 'DESC');
        break;
      case 'highest':
      default:
        qb.orderBy('r.score', 'DESC');
        break;
    }

    const [items, total] = await qb.getManyAndCount();
    const totalPages = Math.ceil(total / pageSize);

    return { items, total, page, pageSize, totalPages };
  }

  // ─── Reputation History ───────────────────────────────────────────────

  async getEvents(
    wallet: string,
    options?: { limit?: number; offset?: number; eventType?: ReputationEventType },
  ): Promise<ReputationEvent[]> {
    const cached = await this.reputationCache.getEvents(wallet);
    if (cached && !options?.eventType) return cached;

    const qb = this.eventRepository
      .createQueryBuilder('e')
      .where('e.walletAddress = :wallet', { wallet: wallet.toLowerCase() })
      .orderBy('e.createdAt', 'DESC');

    if (options?.eventType) {
      qb.andWhere('e.eventType = :eventType', { eventType: options.eventType });
    }

    if (options?.limit) {
      qb.take(options.limit);
    }
    if (options?.offset) {
      qb.skip(options.offset);
    }

    const events = await qb.getMany();

    if (!options?.eventType) {
      await this.reputationCache.setEvents(wallet, events);
    }

    return events;
  }

  // ─── Leaderboards ─────────────────────────────────────────────────────

  async getLeaderboard(
    type: 'highest' | 'fastest_growing' | 'most_active' | 'highest_rewards' = 'highest',
    limit: number = 20,
  ): Promise<LeaderboardEntry[]> {
    const cacheKey = `${type}:${limit}`;
    const cached = await this.reputationCache.getLeaderboard(cacheKey);
    if (cached) return cached;

    const qb = this.reputationRepository.createQueryBuilder('r');

    switch (type) {
      case 'fastest_growing':
        qb.orderBy('r.updatedAt', 'DESC');
        break;
      case 'most_active':
        qb.orderBy('r.verificationCount', 'DESC');
        break;
      case 'highest_rewards':
        qb.orderBy('r.rewardTotal', 'DESC');
        break;
      case 'highest':
      default:
        qb.orderBy('r.score', 'DESC');
        break;
    }

    qb.take(Math.min(limit, 100));

    const records = await qb.getMany();

    const leaderboard: LeaderboardEntry[] = records.map((r, index) => ({
      rank: index + 1,
      walletAddress: r.walletAddress,
      score: r.score,
      verificationCount: r.verificationCount,
      governanceParticipation: r.governanceParticipation,
      rewardTotal: r.rewardTotal,
    }));

    await this.reputationCache.setLeaderboard(cacheKey, leaderboard);
    return leaderboard;
  }

  // ─── Analytics ────────────────────────────────────────────────────────

  async getStats(): Promise<ReputationStats> {
    const cached = await this.reputationCache.getStats();
    if (cached) return cached;

    const totalUsers = await this.reputationRepository.count();

    const allRecords = await this.reputationRepository.find();
    const averageScore =
      allRecords.length > 0
        ? allRecords.reduce((sum, r) => sum + r.score, 0) / allRecords.length
        : 0;
    const highestScore =
      allRecords.length > 0
        ? Math.max(...allRecords.map((r) => r.score))
        : 0;
    const totalVerifications = allRecords.reduce(
      (sum, r) => sum + r.verificationCount,
      0,
    );
    const totalDisputes = allRecords.reduce(
      (sum, r) => sum + r.disputeCount,
      0,
    );

    const stats: ReputationStats = {
      totalUsers,
      averageScore: Number(averageScore.toFixed(2)),
      highestScore,
      totalVerifications,
      totalDisputes,
    };

    await this.reputationCache.setStats(stats);
    return stats;
  }

  // ─── Search ───────────────────────────────────────────────────────────

  async search(
    query: string,
    limit: number = 20,
  ): Promise<ReputationRecord[]> {
    if (!query?.trim()) {
      throw new BadRequestException('Search query is required');
    }

    const qb = this.reputationRepository
      .createQueryBuilder('r')
      .where('r.walletAddress LIKE :query', {
        query: `%${query.toLowerCase()}%`,
      })
      .orderBy('r.score', 'DESC')
      .take(Math.min(limit, 100));

    return qb.getMany();
  }
}
