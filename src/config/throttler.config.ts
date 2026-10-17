import { getRuntimeConfig } from './runtime-config';
import { registerAs } from '@nestjs/config';

export interface RateLimitConfig {
  ttl: number;
  limit: number;
  blockDuration?: number;
}

export interface ThrottlerConfig {
  redis: {
    host: string;
    port: number;
  };
  claims: RateLimitConfig;
  votes: RateLimitConfig;
  disputes: RateLimitConfig;
  auth: RateLimitConfig;
  ai: RateLimitConfig;
  aiStream: RateLimitConfig;
  default: RateLimitConfig;
}

export default registerAs('throttler', (): ThrottlerConfig => {
  const config = getRuntimeConfig();
  function rate(
    name:
      'CLAIMS' | 'VOTES' | 'DISPUTES' | 'AUTH' | 'AI' | 'AI_STREAM' | 'DEFAULT',
  ): RateLimitConfig {
    const ttl = config[`RATE_LIMIT_${name}_TTL`]!;
    return {
      ttl: ttl * 1000,
      limit: config[`RATE_LIMIT_${name}_LIMIT`]!,
      blockDuration:
        (config[`RATE_LIMIT_${name}_BLOCK_DURATION`] ?? ttl) * 1000,
    };
  }
  return {
    redis: { host: config.REDIS_HOST!, port: config.REDIS_PORT! },
    claims: rate('CLAIMS'),
    votes: rate('VOTES'),
    disputes: rate('DISPUTES'),
    auth: rate('AUTH'),
    ai: rate('AI'),
    aiStream: rate('AI_STREAM'),
    default: rate('DEFAULT'),
  };
});
