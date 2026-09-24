import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ContextDocument,
  ContextDocumentCategory,
} from '../entities/context-document.entity';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { AiMetricsService } from '../metrics/ai-metrics.service';
import { AiConfig } from '../config/ai.config';

export interface ContextSearchResult {
  documentId: string;
  title: string;
  content: string;
  score: number;
  sourceUrl?: string;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'with',
  'how',
  'what',
  'why',
  'do',
  'does',
  'did',
  'i',
  'you',
  'it',
  'this',
  'that',
  'my',
  'me',
  'can',
  'could',
  'would',
  'should',
  'will',
  'about',
]);

const CANDIDATE_POOL_LIMIT = 200;

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Pragmatic keyword-based retrieval over the ContextDocument corpus. No
 * vector DB/embeddings exist in this repo yet — this is the documented seam
 * (see docs/AI_ASSISTANT_ARCHITECTURE.md) to swap in real semantic search
 * later without touching callers (PromptOrchestrationService, controllers).
 */
@Injectable()
export class ContextRetrievalService {
  private readonly aiConfig: AiConfig;

  constructor(
    @InjectRepository(ContextDocument)
    private readonly contextDocumentRepository: Repository<ContextDocument>,
    private readonly cache: AiAssistantCache,
    private readonly metrics: AiMetricsService,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
  }

  async search(
    query: string,
    options?: { topN?: number; categories?: ContextDocumentCategory[] },
  ): Promise<ContextSearchResult[]> {
    const topN = options?.topN ?? this.aiConfig.contextTopN;
    const categoryCacheKey = options?.categories?.slice().sort().join(',');

    const cached = await this.cache.getContextResults(query, categoryCacheKey);
    if (cached) {
      this.metrics.recordCacheHit('context');
      return cached.slice(0, topN);
    }
    this.metrics.recordCacheMiss('context');

    const results = await this.searchUncached(query, topN, options?.categories);
    await this.cache.setContextResults(query, results, categoryCacheKey);
    return results;
  }

  private async searchUncached(
    query: string,
    topN: number,
    categories?: ContextDocumentCategory[],
  ): Promise<ContextSearchResult[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return [];
    }

    const qb = this.contextDocumentRepository
      .createQueryBuilder('doc')
      .where('doc.isActive = :active', { active: true });

    if (categories && categories.length > 0) {
      qb.andWhere('doc.category IN (:...categories)', { categories });
    }

    const orClauses = tokens.map(
      (_, i) =>
        `(LOWER(doc.title) LIKE :t${i} OR LOWER(doc.content) LIKE :t${i} OR LOWER(doc.tags) LIKE :t${i})`,
    );
    qb.andWhere(`(${orClauses.join(' OR ')})`);
    tokens.forEach((t, i) => qb.setParameter(`t${i}`, `%${t}%`));
    qb.take(CANDIDATE_POOL_LIMIT);

    const candidates = await qb.getMany();

    const scored = candidates.map((doc) => ({
      doc,
      score: this.score(doc, tokens),
    }));

    scored.sort((a, b) => b.score - a.score);

    const maxScore = scored[0]?.score || 1;

    return scored.slice(0, topN).map(({ doc, score }) => ({
      documentId: doc.id,
      title: doc.title,
      content: doc.content,
      score: Number((score / maxScore).toFixed(4)),
      sourceUrl: doc.sourceUrl,
    }));
  }

  private score(doc: ContextDocument, tokens: string[]): number {
    const title = doc.title.toLowerCase();
    const content = doc.content.toLowerCase();
    const tags = (doc.tags || []).join(' ').toLowerCase();

    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      if (tags.includes(token)) score += 2;
      if (content.includes(token)) score += 1;
    }
    return score;
  }
}
