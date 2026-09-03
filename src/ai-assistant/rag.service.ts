import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(private prisma: PrismaService) {}

  async retrieveContext(query: string): Promise<{ content: string; citations: string[] }> {
    this.logger.debug(`Retrieving context for query: ${query}`);

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

    const context = documents.map((d) => `Source (${d.title}): ${d.content}`).join('\n\n');
    const citations = documents.map((d) => d.title);

    return { content: context || 'No relevant protocol information found.', citations };
  }
}
