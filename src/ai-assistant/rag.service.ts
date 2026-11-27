import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AiConfig } from './config/ai.config';
import { redactPromptText } from '../common/utils/redaction.util';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private prisma: PrismaService,
    private configService?: ConfigService,
  ) {}

  async retrieveContext(
    query: string,
  ): Promise<{ content: string; citations: string[] }> {
    this.logger.debug('Retrieving RAG context');
    const aiConfig = this.configService?.get<AiConfig>('ai');

    // Simple keyword-based retrieval for SQLite
    const words = query.split(' ').filter((w) => w.length > 3);
    const documents = await this.prisma.contextDocument.findMany({
      where: {
        isActive: true,
        OR: words.map((word) => ({
          content: { contains: word },
        })),
      },
      take: 5,
    });

    const context = documents
      .map((d) => {
        const title = aiConfig?.redactBeforeStore
          ? redactPromptText(d.title).text
          : d.title;
        const content = aiConfig?.redactBeforeStore
          ? redactPromptText(d.content).text
          : d.content;
        return `Source (${title}): ${content}`;
      })
      .join('\n\n');
    const citations = documents.map((d) =>
      aiConfig?.redactBeforeStore
        ? redactPromptText(d.title).text
        : d.title,
    );

    return {
      content: context || 'No relevant protocol information found.',
      citations,
    };
  }
}
