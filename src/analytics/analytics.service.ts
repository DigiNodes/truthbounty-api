import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AnalyticsResponse } from './interfaces/analytics-response.interface';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  private async getCached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<{ data: T; cached: boolean }> {
    const cachedData = await this.redisService.get(key);
    if (cachedData) {
      try {
        return { data: JSON.parse(cachedData), cached: true };
      } catch (e) {
        this.logger.error(`Error parsing cached data for ${key}`, e);
      }
    }
    const data = await fetcher();
    await this.redisService.set(key, JSON.stringify(data), ttl);
    return { data, cached: false };
  }

  private wrapResponse<T>(data: T, cached: boolean, processingTimeMs: number, filters: any = {}, pagination?: any): AnalyticsResponse<T> {
    return {
      data,
      metadata: {
        generatedAt: new Date().toISOString(),
        requestIdentifier: uuidv4(),
        filtersApplied: filters,
        processingTimeMs,
        cached,
      },
      pagination,
    };
  }

  async getProtocolStatistics(query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const cacheKey = `analytics:protocol:${JSON.stringify(query)}`;
    
    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      // Mocked or dynamic data depending on entities
      const totalClaims = await this.dataSource.query(`SELECT COUNT(*) as count FROM claim`);
      const activeDisputes = await this.dataSource.query(`SELECT COUNT(*) as count FROM dispute WHERE status = 'ACTIVE'`);
      const registeredContributors = await this.prisma.user.count();

      return {
        totalClaims: parseInt(totalClaims[0]?.count || '0', 10),
        verifiedClaims: 0, // Mock for now or implement
        rejectedClaims: 0,
        activeDisputes: parseInt(activeDisputes[0]?.count || '0', 10),
        completedSettlements: 0,
        registeredContributors,
        governanceProposals: 0,
        protocolParticipation: 0,
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getContributorAnalytics(query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const cacheKey = `analytics:contributors:${JSON.stringify(query)}`;
    
    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      // Return dummy metrics for now, or aggregate if entities are known
      return {
        reputationGrowth: [],
        verificationAccuracy: 0.95,
        disputeParticipation: 10,
        governanceActivity: 5,
        rewardsEarned: 1500,
        contributionHistory: [],
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getClaimAnalytics(query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const cacheKey = `analytics:claims:${JSON.stringify(query)}`;
    
    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      return {
        submissionTrends: [],
        categoryDistribution: {},
        verificationRates: 0.8,
        verificationDuration: '2 days',
        settlementStatistics: {},
        claimOutcomes: {},
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getGovernanceAnalytics(query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const cacheKey = `analytics:governance:${JSON.stringify(query)}`;
    
    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      return {
        proposalStatistics: { total: 0, passed: 0, failed: 0 },
        participationRates: 0.45,
        votingTrends: [],
        quorumAchievement: 0.8,
        treasuryAllocationSummaries: {},
        governanceGrowth: {},
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getRewardAnalytics(query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const cacheKey = `analytics:rewards:${JSON.stringify(query)}`;
    
    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      return {
        rewardsDistributed: 10000,
        rewardPools: {},
        contributorEarnings: {},
        stakingRewards: 5000,
        historicalRewardTrends: [],
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getTrendReporting(query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const cacheKey = `analytics:trends:${JSON.stringify(query)}`;
    
    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      return {
        dailyActivity: [],
        weeklyActivity: [],
        monthlyActivity: [],
        quarterlyActivity: [],
        yearlyGrowth: {},
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }
}
