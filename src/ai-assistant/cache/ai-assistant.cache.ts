import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { AiConfig } from '../config/ai.config';
import { AiChatMessage } from '../providers/ai-provider.interface';

export interface CachedContextResult {
  documentId: string;
  title: string;
  score: number;
  sourceUrl?: string;
  content: string;
}

export interface StreamPendingMarker {
  conversationId: string;
  messageId: string;
  userId: string;
  content: string;
}

const CONTEXT_INDEX_KEY = 'ai:context:index';

@Injectable()
export class AiAssistantCache {
  private readonly logger = new Logger(AiAssistantCache.name);
  private readonly aiConfig: AiConfig;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
  }

  private contextKey(query: string, category?: string): string {
    const hash = createHash('sha1')
      .update(`${query.toLowerCase().trim()}::${category ?? ''}`)
      .digest('hex');
    return `ai:context:${hash}`;
  }

  async getContextResults(
    query: string,
    category?: string,
  ): Promise<CachedContextResult[] | null> {
    const data = await this.redisService.get(this.contextKey(query, category));
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      this.logger.error(
        `Failed to parse cached context results: ${(e as Error).message}`,
      );
      return null;
    }
  }

  async setContextResults(
    query: string,
    results: CachedContextResult[],
    category?: string,
  ): Promise<void> {
    const key = this.contextKey(query, category);
    await this.redisService.set(
      key,
      JSON.stringify(results),
      this.aiConfig.contextCacheTtl,
    );

    // RedisService exposes no keys()/scan(); track active context keys in a
    // small set (via the raw client, exposed "with caution" for exactly this)
    // so they can all be invalidated when the knowledge base changes.
    const client = this.redisService.getClient();
    if (client) {
      try {
        await client.sadd(CONTEXT_INDEX_KEY, key);
      } catch (e) {
        this.logger.warn(
          `Failed to index context cache key: ${(e as Error).message}`,
        );
      }
    }
  }

  async invalidateAllContextResults(): Promise<void> {
    const client = this.redisService.getClient();
    if (!client) return;
    try {
      const keys = await client.smembers(CONTEXT_INDEX_KEY);
      if (keys.length > 0) {
        await client.del(...keys);
      }
      await client.del(CONTEXT_INDEX_KEY);
    } catch (e) {
      this.logger.warn(
        `Failed to invalidate context cache: ${(e as Error).message}`,
      );
    }
  }

  private convoWindowKey(conversationId: string): string {
    return `ai:convo:${conversationId}:window`;
  }

  async getConversationWindow(
    conversationId: string,
  ): Promise<AiChatMessage[] | null> {
    const data = await this.redisService.get(
      this.convoWindowKey(conversationId),
    );
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      this.logger.error(
        `Failed to parse cached conversation window: ${(e as Error).message}`,
      );
      return null;
    }
  }

  async setConversationWindow(
    conversationId: string,
    messages: AiChatMessage[],
  ): Promise<void> {
    await this.redisService.set(
      this.convoWindowKey(conversationId),
      JSON.stringify(messages),
      this.aiConfig.convoWindowCacheTtl,
    );
  }

  async invalidateConversationWindow(conversationId: string): Promise<void> {
    await this.redisService.del(this.convoWindowKey(conversationId));
  }

  private providerAvailabilityKey(providerName: string): string {
    return `ai:provider:availability:${providerName}`;
  }

  async getProviderAvailability(providerName: string): Promise<boolean | null> {
    const data = await this.redisService.get(
      this.providerAvailabilityKey(providerName),
    );
    if (data === null) return null;
    return data === '1';
  }

  async setProviderAvailability(
    providerName: string,
    available: boolean,
  ): Promise<void> {
    await this.redisService.set(
      this.providerAvailabilityKey(providerName),
      available ? '1' : '0',
      this.aiConfig.providerAvailabilityCacheTtl,
    );
  }

  private streamPendingKey(messageId: string): string {
    return `ai:stream:pending:${messageId}`;
  }

  async setStreamPending(marker: StreamPendingMarker): Promise<void> {
    await this.redisService.set(
      this.streamPendingKey(marker.messageId),
      JSON.stringify(marker),
      120,
    );
  }

  async getStreamPending(
    messageId: string,
  ): Promise<StreamPendingMarker | null> {
    const data = await this.redisService.get(this.streamPendingKey(messageId));
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      this.logger.error(
        `Failed to parse pending stream marker: ${(e as Error).message}`,
      );
      return null;
    }
  }

  async clearStreamPending(messageId: string): Promise<void> {
    await this.redisService.del(this.streamPendingKey(messageId));
  }
}
