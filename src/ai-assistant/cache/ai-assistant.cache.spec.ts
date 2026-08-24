import { ConfigService } from '@nestjs/config';
import { AiAssistantCache } from './ai-assistant.cache';
import { RedisService } from '../../redis/redis.service';

describe('AiAssistantCache', () => {
  let cache: AiAssistantCache;
  let redisService: jest.Mocked<
    Pick<RedisService, 'get' | 'set' | 'del' | 'getClient'>
  >;

  const aiConfig = {
    contextCacheTtl: 900,
    convoWindowCacheTtl: 120,
    providerAvailabilityCacheTtl: 30,
  };

  beforeEach(() => {
    redisService = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      getClient: jest.fn().mockReturnValue(null),
    };
    const configService = {
      get: jest.fn().mockReturnValue(aiConfig),
    } as unknown as ConfigService;
    cache = new AiAssistantCache(
      redisService as unknown as RedisService,
      configService,
    );
  });

  describe('context results', () => {
    it('returns null on cache miss', async () => {
      redisService.get.mockResolvedValue(null);
      await expect(cache.getContextResults('staking')).resolves.toBeNull();
    });

    it('round-trips cached context results and honors the configured TTL', async () => {
      const results = [
        { documentId: 'd1', title: 'Staking', score: 0.9, content: 'text' },
      ];
      redisService.get.mockResolvedValue(JSON.stringify(results));

      await cache.setContextResults('staking', results, 'protocol_docs');
      await expect(cache.getContextResults('staking')).resolves.toEqual(
        results,
      );

      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^ai:context:/),
        JSON.stringify(results),
        900,
      );
    });

    it('gracefully returns null when Redis is unavailable', async () => {
      redisService.get.mockResolvedValue(null);
      await expect(cache.getContextResults('anything')).resolves.toBeNull();
    });
  });

  describe('conversation window', () => {
    it('sets and reads back a cached window', async () => {
      const messages = [{ role: 'user' as const, content: 'hi' }];
      redisService.get.mockResolvedValue(JSON.stringify(messages));

      await cache.setConversationWindow('conv-1', messages);
      expect(redisService.set).toHaveBeenCalledWith(
        'ai:convo:conv-1:window',
        JSON.stringify(messages),
        120,
      );
      await expect(cache.getConversationWindow('conv-1')).resolves.toEqual(
        messages,
      );
    });

    it('invalidates on demand', async () => {
      await cache.invalidateConversationWindow('conv-1');
      expect(redisService.del).toHaveBeenCalledWith('ai:convo:conv-1:window');
    });
  });

  describe('provider availability', () => {
    it('stores booleans as 1/0 and reads them back', async () => {
      await cache.setProviderAvailability('openai', true);
      expect(redisService.set).toHaveBeenCalledWith(
        'ai:provider:availability:openai',
        '1',
        30,
      );

      redisService.get.mockResolvedValue('1');
      await expect(cache.getProviderAvailability('openai')).resolves.toBe(true);

      redisService.get.mockResolvedValue('0');
      await expect(cache.getProviderAvailability('openai')).resolves.toBe(
        false,
      );

      redisService.get.mockResolvedValue(null);
      await expect(cache.getProviderAvailability('openai')).resolves.toBeNull();
    });
  });

  describe('stream pending marker', () => {
    it('round-trips and clears the marker', async () => {
      const marker = {
        conversationId: 'c1',
        messageId: 'm1',
        userId: 'u1',
        content: 'hi',
      };
      redisService.get.mockResolvedValue(JSON.stringify(marker));

      await cache.setStreamPending(marker);
      await expect(cache.getStreamPending('m1')).resolves.toEqual(marker);

      await cache.clearStreamPending('m1');
      expect(redisService.del).toHaveBeenCalledWith('ai:stream:pending:m1');
    });
  });
});
