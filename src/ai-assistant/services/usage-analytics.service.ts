import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { AiUsageEndpoint, AiUsageLog, AiUsageStatus } from '../entities/ai-usage-log.entity';
import { UsageAnalyticsQueryDto } from '../dto/usage-analytics-query.dto';

export interface RecordUsageEntry {
  readonly userId: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly provider: string;
  readonly model?: string;
  readonly endpoint: AiUsageEndpoint;
  readonly status: AiUsageStatus;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly latencyMs?: number;
  readonly cacheHit?: boolean;
  readonly errorCode?: string;
}
export interface UsageSummary {
  readonly totalRequests: number;
  readonly totalTokens: number | string;
  readonly averageLatencyMs: number;
  readonly uncertainRequests: number;
  readonly unpricedRequests: number;
  readonly costUsdNanos: string | null;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byEndpoint: Readonly<Record<string, number>>;
}
interface Totals {
  readonly tokens: bigint;
  readonly spend: bigint;
  readonly latency: number;
  readonly uncertain: number;
  readonly unpriced: number;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byEndpoint: Readonly<Record<string, number>>;
}

@Injectable()
export class UsageAnalyticsService {
  constructor(
    @InjectRepository(AiUsageLog)
    private readonly usageLogRepository: Repository<AiUsageLog>,
  ) {}

  async record(entry: RecordUsageEntry): Promise<AiUsageLog> {
    const counts = this.counts(entry);
    const log = this.usageLogRepository.create({
      userId: entry.userId, conversationId: entry.conversationId,
      messageId: entry.messageId, provider: entry.provider, model: entry.model,
      endpoint: entry.endpoint, status: entry.status, ...counts,
      latencyMs: typeof entry.latencyMs === 'number' && Number.isFinite(entry.latencyMs) ?
        Math.max(0, Math.min(Math.round(entry.latencyMs), 2147483647)) : 0,
      cacheHit: entry.cacheHit ?? false, errorCode: entry.errorCode,
      budgetAttemptId: null, priceVersion: null, chargedTokens: null, costUsdNanos: null,
    });
    return this.usageLogRepository.save(log);
  }

  private counts(entry: RecordUsageEntry) {
    const valid = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!valid(entry.promptTokens) || !valid(entry.completionTokens)) return {
      promptTokens: null, completionTokens: null, totalTokens: null, usageComplete: false,
    };
    const total = BigInt(entry.promptTokens) + BigInt(entry.completionTokens);
    if (entry.totalTokens !== undefined &&
        (!valid(entry.totalTokens) || BigInt(entry.totalTokens) !== total)) return {
      promptTokens: null, completionTokens: null, totalTokens: null, usageComplete: false,
    };
    return {
      promptTokens: entry.promptTokens, completionTokens: entry.completionTokens,
      totalTokens: total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total.toString(),
      usageComplete: true,
    };
  }

  async getSummary(query: UsageAnalyticsQueryDto): Promise<UsageSummary> {
    const dates = query.from || query.to ? {
      createdAt: Between(query.from ? new Date(query.from) : new Date(0),
        query.to ? new Date(query.to) : new Date()),
    } : {};
    const where = { ...dates, ...(query.provider ? { provider: query.provider } : {}) };
    const logs = await this.usageLogRepository.find({ where });
    const totals = logs.reduce<Totals>((sum, log) => this.add(sum, log), {
      tokens: 0n, spend: 0n, latency: 0, uncertain: 0, unpriced: 0,
      byProvider: {}, byStatus: {}, byEndpoint: {},
    });
    return {
      totalRequests: logs.length,
      totalTokens: totals.tokens <= BigInt(Number.MAX_SAFE_INTEGER) ?
        Number(totals.tokens) : totals.tokens.toString(),
      averageLatencyMs: logs.length ? Math.round(totals.latency / logs.length) : 0,
      uncertainRequests: totals.uncertain, unpricedRequests: totals.unpriced,
      costUsdNanos: totals.unpriced > 0 ? null : totals.spend.toString(),
      byProvider: totals.byProvider, byStatus: totals.byStatus, byEndpoint: totals.byEndpoint,
    };
  }

  private amount(value: number | string | null | undefined): bigint | null {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    }
    return typeof value === 'string' && /^(0|[1-9][0-9]*)$(?![\s\S])/.test(value) ? BigInt(value) : null;
  }

  private increment(counts: Readonly<Record<string, number>>, key: string) {
    return { ...counts, [key]: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1 };
  }

  private add(sum: Totals, log: AiUsageLog): Totals {
    const tokens = this.amount(log.totalTokens);
    const spend = this.amount(log.costUsdNanos);
    const paid = log.provider === 'openai' || log.provider === 'anthropic';
    return {
      tokens: sum.tokens + (tokens ?? 0n), spend: sum.spend + (paid ? spend ?? 0n : 0n),
      latency: sum.latency + log.latencyMs,
      uncertain: sum.uncertain + (log.usageComplete !== true || tokens === null ? 1 : 0),
      unpriced: sum.unpriced + (paid && spend === null ? 1 : 0),
      byProvider: this.increment(sum.byProvider, log.provider),
      byStatus: this.increment(sum.byStatus, log.status),
      byEndpoint: this.increment(sum.byEndpoint, log.endpoint),
    };
  }
}
