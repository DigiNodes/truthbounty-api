import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  AiUsageEndpoint,
  AiUsageLog,
  AiUsageStatus,
} from '../entities/ai-usage-log.entity';
import { UsageAnalyticsQueryDto } from '../dto/usage-analytics-query.dto';

export interface RecordUsageEntry {
  userId: string;
  conversationId?: string;
  messageId?: string;
  provider: string;
  model?: string;
  endpoint: AiUsageEndpoint;
  status: AiUsageStatus;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  cacheHit?: boolean;
  errorCode?: string;
}

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  averageLatencyMs: number;
  byProvider: Record<string, number>;
  byStatus: Record<string, number>;
  byEndpoint: Record<string, number>;
}

@Injectable()
export class UsageAnalyticsService {
  constructor(
    @InjectRepository(AiUsageLog)
    private readonly usageLogRepository: Repository<AiUsageLog>,
  ) {}

  async record(entry: RecordUsageEntry): Promise<AiUsageLog> {
    const log = this.usageLogRepository.create({
      userId: entry.userId,
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      provider: entry.provider,
      model: entry.model,
      endpoint: entry.endpoint,
      status: entry.status,
      promptTokens: entry.promptTokens ?? 0,
      completionTokens: entry.completionTokens ?? 0,
      totalTokens: entry.totalTokens ?? 0,
      latencyMs: entry.latencyMs ?? 0,
      cacheHit: entry.cacheHit ?? false,
      errorCode: entry.errorCode,
    });
    return this.usageLogRepository.save(log);
  }

  async getSummary(query: UsageAnalyticsQueryDto): Promise<UsageSummary> {
    const where: Record<string, unknown> = {};
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from) : new Date(0);
      const to = query.to ? new Date(query.to) : new Date();
      where.createdAt = Between(from, to);
    }
    if (query.provider) {
      where.provider = query.provider;
    }

    const logs = await this.usageLogRepository.find({ where });

    const summary: UsageSummary = {
      totalRequests: logs.length,
      totalTokens: 0,
      averageLatencyMs: 0,
      byProvider: {},
      byStatus: {},
      byEndpoint: {},
    };

    let latencySum = 0;
    for (const log of logs) {
      summary.totalTokens += log.totalTokens;
      latencySum += log.latencyMs;
      summary.byProvider[log.provider] =
        (summary.byProvider[log.provider] ?? 0) + 1;
      summary.byStatus[log.status] = (summary.byStatus[log.status] ?? 0) + 1;
      summary.byEndpoint[log.endpoint] =
        (summary.byEndpoint[log.endpoint] ?? 0) + 1;
    }
    summary.averageLatencyMs =
      logs.length > 0 ? Math.round(latencySum / logs.length) : 0;

    return summary;
  }
}
