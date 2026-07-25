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
      blockDuration: parseInt(process.env.RATE_LIMIT_CLAIMS_BLOCK_DURATION || process.env.RATE_LIMIT_CLAIMS_TTL || '60', 10) * 1000,
    },
    votes: {
      ttl: parseInt(process.env.RATE_LIMIT_VOTES_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_VOTES_LIMIT || '20', 10),
      blockDuration: parseInt(process.env.RATE_LIMIT_VOTES_BLOCK_DURATION || process.env.RATE_LIMIT_VOTES_TTL || '60', 10) * 1000,
    },
    disputes: {
      ttl: parseInt(process.env.RATE_LIMIT_DISPUTES_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_DISPUTES_LIMIT || '3', 10),
      blockDuration: parseInt(process.env.RATE_LIMIT_DISPUTES_BLOCK_DURATION || process.env.RATE_LIMIT_DISPUTES_TTL || '60', 10) * 1000,
    },
    auth: {
      ttl: parseInt(process.env.RATE_LIMIT_AUTH_TTL || '60', 10) * 1000,
      limit: parseInt(process.env.RATE_LIMIT_AUTH_LIMIT || '5', 10),
      blockDuration: parseInt(process.env.RATE_LIMIT_AUTH_BLOCK_DURATION || process.env.RATE_LIMIT_AUTH_TTL || '60', 10) * 1000,
    },
    default: {
      ttl: parseInt(process.env.RATE_LIMIT_DEFAULT_TTL || '60', 10) * 1000, // 60 seconds
      limit: parseInt(process.env.RATE_LIMIT_DEFAULT_LIMIT || '10', 10),
      blockDuration: parseInt(process.env.RATE_LIMIT_DEFAULT_BLOCK_DURATION || process.env.RATE_LIMIT_DEFAULT_TTL || '60', 10) * 1000,
    },
  }),
);
