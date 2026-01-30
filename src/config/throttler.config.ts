import { registerAs } from '@nestjs/config';

export interface RateLimitConfig {
  ttl: number;
  limit: number;
}

export interface ThrottlerConfig {
  redis: {
    host: string;
    port: number;
  };
  claims: RateLimitConfig;
  votes: RateLimitConfig;
  disputes: RateLimitConfig;
  default: RateLimitConfig;
}

export default registerAs(
  'throttler',
  (): ThrottlerConfig => ({
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
    claims: {
      ttl: parseInt(process.env.RATE_LIMIT_CLAIMS_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_CLAIMS_LIMIT || '5', 10),
    },
    votes: {
      ttl: parseInt(process.env.RATE_LIMIT_VOTES_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_VOTES_LIMIT || '20', 10),
    },
    disputes: {
      ttl: parseInt(process.env.RATE_LIMIT_DISPUTES_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_DISPUTES_LIMIT || '3', 10),
    },
    default: {
      ttl: 60000, // 60 seconds
      limit: 10,
    },
  }),
);
