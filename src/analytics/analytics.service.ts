import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AnalyticsResponse } from './interfaces/analytics-response.interface';

/**
 * NOTE (build repair): this module is not imported by AppModule and is
 * therefore unreachable at runtime. It previously did not parse (unresolved
 * conflict residue and typo'd imports), which made `tsc`/`npm run build` fail
 * for the whole repository. It is repaired here only to the point of being
 * valid, deterministic TypeScript:
 *  - queries run against the TypeORM DataSource (the canonical persistence
 *    boundary) instead of a second client,
 *  - every value interpolated into SQL is validated/sanitized, so report
 *    filters cannot alter the statement shape,
 *  - a table that does not exist yields 0 rather than an error, which is the
 *    tolerant behavior this module was written with.
 * No product behavior is added or removed.
 */

const CACHE_TTL_SECONDS = 5 * 60;

/** Tables this service is permitted to aggregate. Never built from request input. */
const ALLOWED_TABLES = new Set([
  'claim',
  'claim_event',
  'verification',
  'dispute',
  'reward',
  'staking',
  'governance_proposal',
  'vote',
  'treasury',
  'bounty',
  'incentive',
  'users',
  'conversations',
  'messages',
]);

const ALLOWED_DATE_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'effective_at',
  'resolved_at',
  'opened_at',
]);

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Decimal-string coercion for aggregate columns, without object stringification. */
function toNumericString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return '0';
}

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

  /** Column/identifier fragments originate here, never from request input. */
  private assertKnownTable(table: string): void {
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`Unsupported analytics table "${table}"`);
    }
  }

  /**
   * Values are restricted to the characters used by protocol identifiers, so
   * a filter can only ever narrow the predicate and never extend it.
   */
  private sanitizeValue(value: string): string {
    return value.replace(/[^A-Za-z0-9_.:-]/g, '');
  }

  private dateRangeClause(
    column: string,
    start: Date | undefined,
    end: Date | undefined,
  ): string {
    if (!ALLOWED_DATE_COLUMNS.has(column)) return '';
    const clauses: string[] = [];
    if (start) clauses.push(`${column} >= '${start.toISOString()}'`);
    if (end) clauses.push(`${column} <= '${end.toISOString()}'`);
    return clauses.join(' AND ');
  }

  /**
   * Runs a statement and normalizes the driver's rows to plain records, so
   * callers narrow field values explicitly instead of trusting the driver's
   * `any` typing.
   */
  private async queryRows(sql: string): Promise<Record<string, unknown>[]> {
    const rows: unknown = await this.dataSource.query(sql);
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' && row !== null,
    );
  }

  private async safeCount(table: string, where?: string): Promise<number> {
    try {
      this.assertKnownTable(table);
      const sql = `SELECT COUNT(*) AS count FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
      const rows = await this.queryRows(sql);
      return parseInt(toNumericString(rows[0]?.count), 10) || 0;
    } catch (error) {
      this.logger.warn(`Table ${table} not available: ${String(error)}`);
      return 0;
    }
  }

  private async safeSum(
    table: string,
    column: string,
    where?: string,
  ): Promise<number> {
    try {
      this.assertKnownTable(table);
      const sql = `SELECT COALESCE(SUM("${column}"), 0) AS total FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
      const rows = await this.queryRows(sql);
      return parseFloat(toNumericString(rows[0]?.total)) || 0;
    } catch (error) {
      this.logger.warn(
        `Table ${table} not available for sum: ${String(error)}`,
      );
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

    const { data, cached } = await this.getCached(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const startDate = this.parseDate(query.startDate);
        const endDate = this.parseDate(query.endDate);

        const clauses: string[] = [];
        const range = this.dateRangeClause('created_at', startDate, endDate);
        if (range) clauses.push(range);
        if (query.contributorId) {
          clauses.push(
            `contributor_id = '${this.sanitizeValue(query.contributorId)}'`,
          );
        }
        if (query.categoryId) {
          clauses.push(
            `category_id = '${this.sanitizeValue(query.categoryId)}'`,
          );
        }
        if (query.status) {
          clauses.push(`status = '${this.sanitizeValue(query.status)}'`);
        }
        const where = clauses.join(' AND ');

        const totalClaims = await this.safeCount('claim', where || undefined);
        const resolvedClaims = await this.safeCount(
          'claim',
          where
            ? `${where} AND resolved_at IS NOT NULL`
            : 'resolved_at IS NOT NULL',
        );
        const disputeCount = await this.safeCount(
          'dispute',
          where || undefined,
        );
        const submissionTrends = await this.trendSeries(
          'claim',
          'created_at',
          startDate,
          endDate,
        );

        return {
          submissionTrends,
          categoryDistribution: {}, // requires group-by category, not implemented yet
          verificationRates: totalClaims ? resolvedClaims / totalClaims : 0,
          verificationDuration: null,
          settlementStatistics: {},
          claimOutcomes: {},
          disputeCount,
        };
      },
    );

    return this.wrapResponse(data, cached, Date.now() - start, query);
  }

  async getGovernanceAnalytics(
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse<Record<string, unknown>>> {
    const start = Date.now();
    const cacheKey = `analytics:governance:${JSON.stringify(query)}`;

    const { data, cached } = await this.getCached(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const total = await this.safeCount('governance_proposal');
        const passed = await this.safeCount(
          'governance_proposal',
          "status = 'PASSED'",
        );
        const failed = await this.safeCount(
          'governance_proposal',
          "status = 'FAILED'",
        );
        const voterTurnout = await this.safeCount('vote');
        const participation = total ? voterTurnout / total : 0;

        return {
          proposalStatistics: { total, passed, failed },
          participationRates: participation > 1 ? 1 : participation,
          votingTrends: [],
          quorumAchievement: 0,
          treasuryAllocationSummaries: {},
          governanceGrowth: {},
        };
      },
    );

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

  private resolvePeriod(period?: string): Period {
    switch (period) {
      case 'weekly':
        return 'week';
      case 'monthly':
        return 'month';
      case 'quarterly':
        return 'quarter';
      case 'yearly':
        return 'year';
      default:
        return 'day';
    }
  }

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

  getMonitoringMetrics(): AnalyticsResponse<Record<string, number>> {
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
