import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmProviderService } from './llm-provider.service';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private prisma: PrismaService,
    private llmProvider: LlmProviderService,
  ) {}

  async retrieveContext(query: string): Promise<{ context: string; citations: string[] }> {
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

    return {
      context: relevantDocs.map(doc => `[${doc.title}]: ${doc.content}`).join('\n\n'),
      citations: relevantDocs.map(doc => doc.title)
    };
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
