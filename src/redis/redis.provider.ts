import { getRuntimeConfig } from '../config/runtime-config';
import Redis from 'ioredis';

export const RedisProvider = {
  provide: 'REDIS_CLIENT',
  useFactory: () => {
    const config = getRuntimeConfig();
    return new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD,
      db: config.REDIS_DB,
      tls: config.REDIS_TLS ? {} : undefined,
    });
  },
};
