import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

jest.mock('ioredis', () => jest.fn());

describe('Redis startup policy', () => {
  const client = { on: jest.fn(), ping: jest.fn(), disconnect: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    (Redis as unknown as jest.Mock).mockImplementation(() => client);
    client.ping.mockRejectedValue(new Error('credential-canary'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['production', 'staging'])(
    'fails closed in %s without logging connection details',
    async (NODE_ENV) => {
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
    },
  );
  it('preserves development-only cache degradation', async () => {
    const service = new RedisService(
      new ConfigService({ NODE_ENV: 'development' }),
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.get('key')).resolves.toBeNull();
  });
});
