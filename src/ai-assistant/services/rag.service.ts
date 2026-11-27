import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AiConfig } from '../config/ai.config';
import { redactPromptText } from '../../common/utils/redaction.util';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private prisma: PrismaService,
    private redisService: RedisService,
    private configService?: ConfigService,
  ) {}

  async retrieveContext(
    query: string,
  ): Promise<{ context: string; citations: string[] }> {
    const aiConfig = this.configService?.get<AiConfig>('ai');
    const keyMaterial = aiConfig?.redactionCacheKey || 'local-ai-context-key';
    const queryDigest = createHmac('sha256', keyMaterial)
      .update(query.trim().toLowerCase())
      .digest('hex');
    const cacheKey = `rag_context:${queryDigest}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      this.logger.debug('RAG cache hit');
      const parsed = JSON.parse(cached) as {
        context: string;
        citations: string[];
      };
      if (!aiConfig?.redactBeforeStore) return parsed;
      return {
        context: redactPromptText(parsed.context).text,
        citations: parsed.citations.map(
          (citation) => redactPromptText(citation).text,
        ),
      };
    }

    this.logger.debug('Retrieving RAG context');

    // 1. Fetch all active documents
    const documents = await this.prisma.contextDocument.findMany({
      where: { isActive: true },
    });

    if (documents.length === 0) {
      return { context: 'No protocol documentation found.', citations: [] };
    }

    // 2. Simple keyword-based ranking for now as a fallback
    const relevantDocs = documents
      .map((doc) => ({
        ...doc,
        score: this.calculateRelevance(query, doc.content + ' ' + doc.title),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3); // Take top 3

    const result = {
      context: relevantDocs
        .map((doc) => {
          const title = aiConfig?.redactBeforeStore
            ? redactPromptText(doc.title).text
            : doc.title;
          const content = aiConfig?.redactBeforeStore
            ? redactPromptText(doc.content).text
            : doc.content;
          return `[${title}]: ${content}`;
        })
        .join('\n\n'),
      citations: relevantDocs.map((doc) =>
        aiConfig?.redactBeforeStore
          ? redactPromptText(doc.title).text
          : doc.title,
      ),
    };

    await this.redisService.set(cacheKey, JSON.stringify(result), 3600); // 1 hour cache
    return result;
  }

  private calculateRelevance(query: string, content: string): number {
    const queryTerms = query.toLowerCase().split(/\s+/);
    let score = 0;
    queryTerms.forEach((term) => {
      if (content.toLowerCase().includes(term)) {
        score += 1;
      }
    });
    return score;
  }
}
