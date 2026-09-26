import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AnalyticsResponse } from './interfaces/analytics-response.interface';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  private monitoring = {
    reportGenerationCount: 0,
    queryLatencySum: 0,
    cacheHits: 0,
    cacheMisses: 0,
    exportRequests: 0,
    failedReportGeneration: 0,
    lastRefreshDuration: 0,
  };

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
  ) {}

  private async getCached<T>(
    key: string,
    ttl: number,
    fetcher: () => Promise<T>,
  ): Promise<{ data: T; cached: boolean }> {
    const cachedData = await this.redisService.get(key);
    if (cachedData) {
      this.monitoring.cacheHits++;
      try {
        return { data: JSON.parse(cachedData) as T, cached: true };
      } catch (error) {
        this.logger.error(
          `Error parsing cached data for ${key}: ${String(error)}`,
        );
      }
    }
    this.monitoring.cacheMisses++;
    const data = await fetcher();
    await this.redisService.set(key, JSON.stringify(data), ttl);
    return { data, cached: false };
  }

  private wrapResponse<T>(
    data: T,
    cached: boolean,
    processingTimeMs: number,
    filters: object = {},
    pagination?: AnalyticsResponse<T>['pagination'],
  ): AnalyticsResponse<T> {
    return {
      data,
      metadata: {
        generatedAt: new Date().toISOString(),
        requestIdentifier: randomUUID(),
        filtersApplied: filters as Record<string, unknown>,
        processingTimeMs,
        cached,
      },
      pagination,
    };
  }

  private parseDate(date?: string): Date | undefined {
    return date ? new Date(date) : undefined;
  }

  private async safeRawCount(table: string, where?: string): Promise<number> {
    try {
      const sql = `SELECT COUNT(*) as count FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
      const result = await this.dataSource.query(sql);
      return parseInt(result[0]?.count || '0', 10);
    } catch (e) {
      this.logger.warn(`Table ${table} not available`, e);
      return 0;
    }
  }

  private async safeRawSum(table: string, column: string, where?: string): Promise<number> {
    try {
      const sql = `SELECT COALESCE(SUM("${column}"), 0) as total FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
      const result = await this.dataSource.query(sql);
      const total = result[0]?.total || '0';
      return parseFloat(total);
    } catch (e) {
      this.logger.warn(`Table ${table} not available for sum`, e);
      return 0;
    }
  }

  private async trendSeries(
    table: string,
    column: string,
    start: Date | undefined,
    end: Date | undefined,
  ): Promise<{ period: string; count: number }[]> {
    try {
      this.assertKnownTable(table);
      const where = this.dateRangeClause(column, start, end);
      const sql =
        `SELECT substr(${column}, 1, 10) AS period, COUNT(*) AS count FROM "${table}"` +
        `${where ? ` WHERE ${where}` : ''} GROUP BY period ORDER BY period`;
      const rows = await this.queryRows(sql);

      // Buckets are rebuilt in application code so day/week/month/quarter/year
      // grouping is identical across PostgreSQL and SQLite.
      const buckets = new Map<string, number>();
      for (const row of rows) {
        const period = row.period;
        if (typeof period !== 'string' || period === '') continue;
        buckets.set(period, (buckets.get(period) ?? 0) + Number(row.count));
      }
      return [...buckets.entries()]
        .map(([period, count]) => ({ period, count }))
        .sort((a, b) => a.period.localeCompare(b.period));
    } catch (error) {
      this.logger.warn(`Trend query failed for ${table}: ${String(error)}`);
      return [];
    }
  }

  async getProtocolStatistics(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, number>>> {
    const start = Date.now();
    const cacheKey = `analytics:protocol:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const totalClaims = await this.safeCount('claim');
        const activeClaims = await this.safeCount('claim', "status = 'OPEN'");
        const resolvedClaims = await this.safeCount(
          'claim',
          "status IN ('VERIFIED_TRUE', 'VERIFIED_FALSE', 'INCONCLUSIVE')",
        );
        const verificationCount = await this.safeCount('verification');
        const disputeCount = await this.safeCount('dispute');
        const rewardsDistributed = await this.safeSum('reward', 'amount');
        const stakingVolume = await this.safeSum('staking', 'amount');
        const governanceProposals = await this.safeCount('governance_proposal');
        const governanceParticipation = await this.safeCount('vote');

        const startDate = this.parseDate(query.startDate);
        const endDate = this.parseDate(query.endDate);
        const newUserClause = this.dateRangeClause(
          'created_at',
          startDate,
          endDate,
        );

        const registeredContributors = await this.safeCount('users');
        const newUsers = await this.safeCount(
          'users',
          newUserClause || undefined,
        );

        return {
          totalClaims,
          activeClaims,
          resolvedClaims,
          verificationCount,
          disputeCount,
          rewardsDistributed,
          stakingVolume,
          governanceProposals,
          governanceParticipation,
          registeredContributors,
          newUsers,
        };
      },
    );

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getContributorAnalytics(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, unknown>>> {
    const start = Date.now();
    const cacheKey = `analytics:contributors:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const startDate = this.parseDate(query.startDate);
        const endDate = this.parseDate(query.endDate);
        const createdClause = this.dateRangeClause(
          'created_at',
          startDate,
          endDate,
        );

        const totalContributors = await this.safeCount('users');
        const newUsers = await this.safeCount(
          'users',
          createdClause || undefined,
        );
        const activeContributors = await this.safeCount(
          'conversations',
          createdClause || undefined,
        );

        return {
          totalContributors,
          newUsers,
          activeContributors,
          activeVerifiers: 0, // requires verification-table grouping, not implemented yet
          moderatorActivity: 0,
          governanceParticipation: 0,
          contributorRetention: 0,
          reputationDistribution: [] as { reputation: string; count: number }[],
        };
      },
    );

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getClaimAnalytics(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, unknown>>> {
    const start = Date.now();
    const cacheKey = `analytics:claims:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      const startDate = this.parseDate(query.startDate);
      const endDate = this.parseDate(query.endDate);
      let whereClaim = ['created_at' >= 'startDate', 'created_at' <= 'endDate'].join(' AND ');
      if (query.contributorId) whereClaim += ` AND contributor_id = '${query.contributorId}'`;
      if (query.categoryId) whereClaim += ` AND category_id = '${query.categoryId}'`;
      if (query.status) whereClaim += ` AND status = '${query.status}'`;

      const totalClaims = await this.safeRawCount('claim', whereClaim);
      const verificationRates = await this.safeRawCount('verification', whereClaim);
      const disputeCount = await this.safeRawCount('dispute', whereClaim);

      const submissionTrends = await this.getTrendArray('claim', 'created_at', startDate, endDate, query.period);

      return {
        submissionTrends,
        categoryDistribution: {}, // Requires group by category, not implemented yet
        verificationRates: verificationRates ? verificationRates/(totalClaims || 1) : 0,
        verificationDuration: null,
        settlementStatistics: {},
        claimOutcomes: {},
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getGovernanceAnalytics(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, unknown>>> {
    const start = Date.now();
    const cacheKey = `analytics:governance:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(cacheKey, 60 * 5, async () => {
      const total = await this.safeRawCount('gvn_proposal');
      const passed = await this.safeRawCount('gvn_proposal', "status = 'PASSED'");
      const failed = await this.safeRawCount('gvn_proposal', "status = 'FAILED'");
      const voterTurnout = await this.safeRawCount('vote');
      const participation = total ? voterTurnout / total : 0;

      return {
        proposalStatistics: { total, passed, failed },
        participationRates: participation > 1 ? 1 : participation,
        votingTrends: [],
        quorumAchievement: 0,
        treasuryAllocationSummaries: {},
        governanceGrowth: {},
      };
    });

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getRewardAnalytics(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, number>>> {
    const start = Date.now();
    const cacheKey = `analytics:rewards:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const startDate = this.parseDate(query.startDate);
        const endDate = this.parseDate(query.endDate);
        const where = this.dateRangeClause('created_at', startDate, endDate);

        const rewardsDistributed = await this.safeSum(
          'reward',
          'amount',
          where || undefined,
        );
        const stakingRewards = await this.safeSum(
          'staking',
          'amount',
          where || undefined,
        );
        const treasuryBalance = await this.safeSum('treasury', 'balance');
        const bountyAllocations = await this.safeSum(
          'bounty',
          'allocated_amount',
          where || undefined,
        );
        const protocolIncentives = await this.safeSum(
          'incentive',
          'amount',
          where || undefined,
        );

        return {
          rewardsDistributed,
          stakingRewards,
          treasuryBalance,
          bountyAllocations,
          protocolIncentives,
        };
      },
    );

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getTrendReporting(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, unknown>>> {
    const start = Date.now();
    const cacheKey = `analytics:trends:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const startDate = this.parseDate(query.startDate);
        const endDate = this.parseDate(query.endDate);
        const period: Period = this.resolvePeriod(query.period);

        const activity = await this.trendSeries(
          'claim',
          'created_at',
          startDate,
          endDate,
        );

        return {
          period,
          activity,
          yearlyGrowth: this.bucketTrend(activity, 'year'),
        };
      },
    );

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  private async getMessageTrends(period: string, start: Date | undefined, end: Date | undefined): Promise<any[]> {
    const startDate = start ? start : new Date(0);
    const endDate = end ? end : new Date();

    // Use Prisma to group messages by createdAt date ranges
    // This is a simplified version; in production, use raw SQL for better performance.
    const messages = await this.prisma.message.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: { createdAt: true },
    });

    if (messages.length === 0) return [];

  private bucketTrend(
    rows: { period: string; count: number }[],
    period: Period,
  ): { period: string; count: number }[] {
    const buckets = new Map<string, number>();
    for (const row of rows) {
      const date = new Date(`${row.period}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) continue;
      let key: string;
      switch (period) {
        case 'week': {
          const weekStart = new Date(date);
          weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
          key = weekStart.toISOString().slice(0, 10);
          break;
        }
        case 'month':
          key = row.period.slice(0, 7);
          break;
        case 'quarter':
          key = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
          break;
        case 'year':
          key = String(date.getUTCFullYear());
          break;
        default:
          key = row.period.slice(0, 10);
      }
      buckets.set(key, (buckets.get(key) ?? 0) + row.count);
    }
    return [...buckets.entries()]
      .map(([key, count]) => ({ period: key, count }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  private async getTrendArray(table: string, column: string, start: Date | undefined, end: Date | undefined, period?: string): Promise<any[]> {
    try {
      const whereClauses: string[] = [];
      if (start) whereClauses.push(`${column} >= '${start.toISOString()}'`);
      if (end) whereClauses.push(`${column} <= '${end.toISOString()}'`);
      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const query = `SELECT strftime(${column}, '%Y-%m-%d') as period, COUNT(*) as count FROM "${table}" ${where} GROUP BY period ORDER BY period`;
      const result = await this.dataSource.query(query);
      return result.map((row) => ({ period: row.period, count: parseInt(row.count, 10) }));
    } catch (e) {
      return [];
    }
  }

  async getMonitoringMetrics(): Promise<AnalyticsResponse<any>> {
    const start = Date.now();
    const totalQueries =
      this.monitoring.cacheHits + this.monitoring.cacheMisses;
    const cacheHitRatio = totalQueries
      ? this.monitoring.cacheHits / totalQueries
      : 0;
    const avgQueryLatency = this.monitoring.reportGenerationCount
      ? this.monitoring.queryLatencySum / this.monitoring.reportGenerationCount
      : 0;

    return this.wrapResponse(
      {
        reportGenerationCount: this.monitoring.reportGenerationCount,
        queryLatencyMs: avgQueryLatency,
        cacheHitRatio,
        avgReportGenerationTime: this.monitoring.lastRefreshDuration,
        exportRequests: this.monitoring.exportRequests,
        failedReportGeneration: this.monitoring.failedReportGeneration,
      },
      false,
      Date.now() - start,
    );
  }

  async generateCsvReport(query: AnalyticsQueryDto): Promise<string> {
    this.monitoring.exportRequests++;
    const start = Date.now();
    try {
      const sections = {
        protocol: (await this.getProtocolStatistics(query)).data,
        contributors: (await this.getContributorAnalytics(query)).data,
        claims: (await this.getClaimAnalytics(query)).data,
        governance: (await this.getGovernanceAnalytics(query)).data,
        rewards: (await this.getRewardAnalytics(query)).data,
        trends: (await this.getTrendReporting(query)).data,
      };

      const csv = this.toCsv(sections);
      this.monitoring.reportGenerationCount++;
      this.monitoring.queryLatencySum += Date.now() - start;
      this.monitoring.lastRefreshDuration = Date.now() - start;
      return csv;
    } catch (error) {
      this.monitoring.failedReportGeneration++;
      throw error;
    }
  }

  private toCsv(sections: Record<string, Record<string, unknown>>): string {
    const rows: string[][] = [['Section', 'Metric', 'Value']];
    for (const [section, metrics] of Object.entries(sections)) {
      for (const [key, value] of Object.entries(metrics)) {
        rows.push([
          section,
          key,
          typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : String(value),
        ]);
      }
    }
    return rows
      .map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','),
      )
      .join('\n');
  }
}
