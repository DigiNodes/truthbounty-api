import { ConfigModule, ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { RedisModule } from './redis.module';
import { CacheModule } from '../cache/cache.module';
import { CacheKeyRegistryService } from '../cache/cache-key-registry.service';

jest.mock('ioredis', () => jest.fn());

describe('Redis startup policy', () => {
  const handlers = new Map<string, () => void>();
  const client = {
    on: jest.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return client;
    }),
    ping: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    (Redis as unknown as jest.Mock).mockImplementation(() => client);
    client.ping.mockImplementation(async () => {
      handlers.get('ready')?.();
      return 'PONG';
    });
    client.quit.mockResolvedValue('OK');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['production', 'staging'])(
    'fails closed in %s without logging connection details',
    async (NODE_ENV) => {
      client.ping.mockRejectedValue(new Error('credential-canary'));
      const service = new RedisService(
        new ConfigService({
          NODE_ENV,
          REDIS_TLS: 'true',
          REDIS_PORT: 6380,
          REDIS_PASSWORD: 'secret',
        }),
      );
      await expect(service.onModuleInit()).rejects.toThrow(
        'Redis unavailable during startup',
      );
      expect(client.disconnect).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).not.toHaveBeenCalled();
      expect(Redis).toHaveBeenCalledWith(
        expect.objectContaining({ port: 6380, password: 'secret', tls: {} }),
      );
      expect(service.getStatus()).toEqual({ connected: false, enabled: false });
    },
  );

  it('preserves development-only cache degradation', async () => {
    client.ping.mockRejectedValueOnce(new Error('connection refused'));
    const service = new RedisService(
      new ConfigService({ NODE_ENV: 'development' }),
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.get('key')).resolves.toBeNull();
    expect(service.getStatus()).toEqual({ connected: false, enabled: true });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Application will continue without Redis caching',
    );

    handlers.get('ready')?.();

    await expect(service.isHealthy()).resolves.toBe(true);
    expect(service.getStatus()).toEqual({ connected: true, enabled: true });
    expect(Redis).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('does not create a client when Redis is explicitly disabled', async () => {
    const service = new RedisService(
      new ConfigService({ REDIS_ENABLED: 'false' }),
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(Redis).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ connected: false, enabled: false });
  });

  it('uses bounded connection and command timeouts', async () => {
    const service = new RedisService(new ConfigService({ NODE_ENV: 'test' }));
    await service.onModuleInit();

    expect(Redis).toHaveBeenCalledWith(
      expect.objectContaining({
        connectTimeout: 5000,
        commandTimeout: 5000,
        enableOfflineQueue: false,
      }),
    );
  });

  it('marks the same client unavailable and healthy as it reconnects', async () => {
    const service = new RedisService(new ConfigService({ NODE_ENV: 'test' }));
    await service.onModuleInit();
    expect(service.getStatus().connected).toBe(true);

    handlers.get('close')?.();
    expect(service.getStatus().connected).toBe(false);
    handlers.get('ready')?.();
    expect(service.getStatus().connected).toBe(true);

    const retryStrategy = (Redis as unknown as jest.Mock).mock.calls[0][0]
      .retryStrategy;
    expect(retryStrategy(1)).toBe(50);
    expect(retryStrategy(100)).toBe(2000);
    expect(Redis).toHaveBeenCalledTimes(1);
  });

  it('closes the client during shutdown and clears its status', async () => {
    const service = new RedisService(new ConfigService({ NODE_ENV: 'test' }));
    await service.onModuleInit();

    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toEqual({ connected: false, enabled: false });
  });

  it('disconnects the client if graceful shutdown fails', async () => {
    const service = new RedisService(new ConfigService({ NODE_ENV: 'test' }));
    await service.onModuleInit();
    client.quit.mockRejectedValueOnce(new Error('shutdown timeout'));

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();

    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toEqual({ connected: false, enabled: false });
  });

  it('shares one Redis client across RedisModule and CacheModule', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ NODE_ENV: 'test', REDIS_ENABLED: 'true' })],
        }),
        RedisModule,
        CacheModule,
      ],
    }).compile();
    await module.init();

    expect(module.get(RedisService)).toBeDefined();
    expect(module.get(CacheKeyRegistryService)).toBeDefined();
    expect(Redis).toHaveBeenCalledTimes(1);

    await module.close();
  });
});
