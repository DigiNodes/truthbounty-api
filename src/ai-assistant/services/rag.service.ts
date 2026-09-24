import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private prisma: PrismaService,
    private redisService: RedisService,
  ) {}

  async retrieveContext(query: string): Promise<{ context: string; citations: string[] }> {
    const cacheKey = `rag_context:${query.trim().toLowerCase()}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for query: ${query}`);
      return JSON.parse(cached);
    }

    this.logger.debug(`Retrieving context for query: ${query}`);
    
    // 1. Fetch all active documents
    const documents = await this.prisma.contextDocument.findMany({
      where: { isActive: true },
    });

    if (documents.length === 0) {
      return { context: 'No protocol documentation found.', citations: [] };
    }

    // 2. Simple keyword-based ranking for now as a fallback
    const relevantDocs = documents
      .map(doc => ({
        ...doc,
        score: this.calculateRelevance(query, doc.content + ' ' + doc.title)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3); // Take top 3

    const result = {
      context: relevantDocs.map(doc => `[${doc.title}]: ${doc.content}`).join('\n\n'),
      citations: relevantDocs.map(doc => doc.title)
    };

    await this.redisService.set(cacheKey, JSON.stringify(result), 3600); // 1 hour cache
    return result;
  }

  private calculateRelevance(query: string, content: string): number {
    const queryTerms = query.toLowerCase().split(/\s+/);
    let score = 0;
    queryTerms.forEach(term => {
      if (content.toLowerCase().includes(term)) {
        score += 1;
      }
    });
    return score;
  }
}
