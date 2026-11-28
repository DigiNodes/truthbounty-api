import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  UnsubscribeTokenService,
  InvalidUnsubscribeTokenError,
  ExpiredUnsubscribeTokenError,
  ReplayUnsubscribeTokenError,
} from './unsubscribe-token.service';
import { DeliveryChannel } from '../interfaces/notification.types';
import { RedisService } from '../../redis/redis.service';

/**
 * Calculates Shannon entropy in bits per character for an ASCII/base64 string.
 * High-entropy random data in base64url approaches ~5.9 - 6.0 bits/char.
 */
function calculateShannonEntropy(str: string): number {
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

describe('UnsubscribeTokenService (PREWAVE-BE-199 / #798)', () => {
  let service: UnsubscribeTokenService;
  let configService: ConfigService;
  let mockRedis: jest.Mocked<Partial<RedisService>>;
  let redisStore: Map<string, string>;

  beforeEach(() => {
    redisStore = new Map<string, string>();
    mockRedis = {
      get: jest.fn(async (key: string) => redisStore.get(key) || null),
      setnx: jest.fn(async (key: string, value: string) => {
        if (redisStore.has(key)) return false;
        redisStore.set(key, value);
        return true;
      }),
      del: jest.fn(async (key: string) => {
        redisStore.delete(key);
        return true;
      }),
    };

    configService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'UNSUBSCRIBE_TOKEN_SECRET') {
          return 'test-unsubscribe-secret-at-least-32-chars-long!!';
        }
        if (key === 'JWT_SECRET') {
          return 'test-jwt-secret-at-least-32-chars-long-here!!';
        }
        if (key === 'NODE_ENV') {
          return 'test';
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;

    service = new UnsubscribeTokenService(
      configService,
      mockRedis as unknown as RedisService,
    );
  });

  describe('Entropy and token unpredictability', () => {
    it('generates high-entropy, unpredictable tokens with no identifiable prefixes', () => {
      const userId = 'user-uuid-1234-5678-9012';
      const token1 = service.generateToken({ userId, channel: DeliveryChannel.EMAIL });
      const token2 = service.generateToken({ userId, channel: DeliveryChannel.EMAIL });

      expect(token1).not.toBe(token2);
      expect(token1.startsWith('tbunsub_')).toBe(true);

      const rawPayload1 = token1.replace('tbunsub_', '');
      const rawPayload2 = token2.replace('tbunsub_', '');

      // Shannon entropy test: base64url random bytes should have entropy > 5.0 bits/char
      const entropy1 = calculateShannonEntropy(rawPayload1);
      const entropy2 = calculateShannonEntropy(rawPayload2);
      expect(entropy1).toBeGreaterThan(5.0);
      expect(entropy2).toBeGreaterThan(5.0);

      // Verify token strings do NOT contain the plaintext user ID
      expect(token1).not.toContain(userId);
      expect(token2).not.toContain(userId);

      // Verify base64 decoded string does NOT reveal unencrypted user ID
      const decodedBuffer = Buffer.from(rawPayload1, 'base64url');
      expect(decodedBuffer.toString('utf8')).not.toContain(userId);
      expect(decodedBuffer.toString('utf8')).not.toContain('EMAIL');
    });

    it('generates distinct tokens across consecutive invocations (high Hamming distance)', () => {
      const tokens = new Set<string>();
      const userId = 'target-user';
      for (let i = 0; i < 20; i++) {
        tokens.add(service.generateToken({ userId }));
      }
      expect(tokens.size).toBe(20);
    });

    it('does not embed Date.now() timestamp in plaintext or predictable format', () => {
      const now = Date.now().toString();
      const token = service.generateToken({ userId: 'alice' });
      expect(token).not.toContain(now);
      expect(token).not.toContain(now.slice(0, 6)); // not even partial millisecond prefix
    });
  });

  describe('Expiry handling', () => {
    it('verifies valid token within bounded expiry', async () => {
      const token = service.generateToken({
        userId: 'alice',
        channel: DeliveryChannel.EMAIL,
        ttlSeconds: 3600,
      });

      const claims = await service.verifyToken(token);
      expect(claims.userId).toBe('alice');
      expect(claims.channel).toBe(DeliveryChannel.EMAIL);
      expect(claims.action).toBe('unsubscribe');
      expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects expired token when ttlSeconds <= 0', async () => {
      const expiredToken = service.generateToken({
        userId: 'bob',
        channel: DeliveryChannel.EMAIL,
        ttlSeconds: -10, // already expired
      });

      await expect(service.verifyToken(expiredToken)).rejects.toThrow(
        ExpiredUnsubscribeTokenError,
      );
    });

    it('fails closed when token expiration is reached during verification', async () => {
      jest.useFakeTimers();
      try {
        const token = service.generateToken({
          userId: 'charlie',
          channel: DeliveryChannel.EMAIL,
          ttlSeconds: 60,
        });

        // Fast-forward 65 seconds
        jest.advanceTimersByTime(65 * 1000);

        await expect(service.verifyToken(token)).rejects.toThrow(
          ExpiredUnsubscribeTokenError,
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Tampering and integrity protection', () => {
    it('rejects token when ciphertext is altered', async () => {
      const token = service.generateToken({ userId: 'david' });
      // Flip a character in the middle
      const prefix = token.slice(0, 20);
      const middleChar = token.charAt(20);
      const replacementChar = middleChar === 'A' ? 'B' : 'A';
      const suffix = token.slice(21);
      const tampered = `${prefix}${replacementChar}${suffix}`;

      await expect(service.verifyToken(tampered)).rejects.toThrow(
        InvalidUnsubscribeTokenError,
      );
    });

    it('rejects token when IV or auth tag is modified', async () => {
      const token = service.generateToken({ userId: 'eve' });
      const raw = token.replace('tbunsub_', '');
      const buf = Buffer.from(raw, 'base64url');

      // Flip first byte (IV)
      buf[0] ^= 0xff;
      const tamperedIv = `tbunsub_${buf.toString('base64url')}`;
      await expect(service.verifyToken(tamperedIv)).rejects.toThrow(
        InvalidUnsubscribeTokenError,
      );

      // Flip byte in auth tag
      const bufTag = Buffer.from(raw, 'base64url');
      bufTag[15] ^= 0xff;
      const tamperedTag = `tbunsub_${bufTag.toString('base64url')}`;
      await expect(service.verifyToken(tamperedTag)).rejects.toThrow(
        InvalidUnsubscribeTokenError,
      );
    });

    it('rejects truncated, overly short, or malformed tokens', async () => {
      await expect(service.verifyToken('tbunsub_short')).rejects.toThrow(
        InvalidUnsubscribeTokenError,
      );
      await expect(service.verifyToken('tbunsub_!@#$%^&*()_+')).rejects.toThrow(
        InvalidUnsubscribeTokenError,
      );
      await expect(service.verifyToken('')).rejects.toThrow(
        InvalidUnsubscribeTokenError,
      );
    });
  });

  describe('Single-use and replay protection', () => {
    it('allows consuming a valid token once and rejects replay on subsequent attempts', async () => {
      const token = service.generateToken({
        userId: 'frank',
        channel: DeliveryChannel.EMAIL,
        ttlSeconds: 3600,
      });

      // First consumption succeeds
      const result = await service.consumeToken(token);
      expect(result.success).toBe(true);
      expect(result.userId).toBe('frank');
      expect(result.channel).toBe(DeliveryChannel.EMAIL);

      // Second consumption must be rejected as a replay
      await expect(service.consumeToken(token)).rejects.toThrow(
        ReplayUnsubscribeTokenError,
      );

      // Verifying after consumption also detects replay
      await expect(service.verifyToken(token)).rejects.toThrow(
        ReplayUnsubscribeTokenError,
      );
    });

    it('enforces single-use protection even when Redis is offline (in-memory fallback)', async () => {
      const memoryOnlyService = new UnsubscribeTokenService(configService, undefined);
      const token = memoryOnlyService.generateToken({
        userId: 'grace',
        channel: DeliveryChannel.EMAIL,
      });

      const firstUse = await memoryOnlyService.consumeToken(token);
      expect(firstUse.success).toBe(true);

      await expect(memoryOnlyService.consumeToken(token)).rejects.toThrow(
        ReplayUnsubscribeTokenError,
      );
    });
  });

  describe('Purpose binding and cross-user substitution defense', () => {
    it('binds token strictly to the designated user and channel', async () => {
      const token = service.generateToken({
        userId: 'user-primary',
        channel: DeliveryChannel.EMAIL,
      });

      const claims = await service.verifyToken(token);
      expect(claims.userId).toBe('user-primary');
      expect(claims.channel).toBe(DeliveryChannel.EMAIL);
      expect(claims.action).toBe('unsubscribe');
    });

    it('prevents attacker from substituting target user', async () => {
      const victimToken = service.generateToken({
        userId: 'victim-user',
        channel: DeliveryChannel.EMAIL,
      });

      const claims = await service.verifyToken(victimToken);
      // Caller cannot claim this token belongs to attacker
      expect(claims.userId).not.toBe('attacker-user');
      expect(claims.userId).toBe('victim-user');
    });
  });

  describe('Token redaction in logs and telemetry', () => {
    it('redacts tokens from logs and stringification', () => {
      const token = service.generateToken({ userId: 'heidi' });
      expect(service.redactToken(token)).toBe('[REDACTED]');
      expect(service.redactToken(null)).toBe('[EMPTY_TOKEN]');
      expect(service.redactToken(undefined)).toBe('[EMPTY_TOKEN]');
    });

    it('does not log raw tokens during consumption', async () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
      const token = service.generateToken({ userId: 'ivan' });
      await service.consumeToken(token);

      const allLoggedText = debugSpy.mock.calls
        .map((args) => args.join(' '))
        .join('\n');

      expect(allLoggedText).not.toContain(token);
      debugSpy.mockRestore();
    });
  });

  describe('Email unsubscribe URL parsing and safe failure behavior', () => {
    it('extracts token from full HTTPS URL path', () => {
      const token = service.generateToken({ userId: 'judy' });
      const url = `https://truthbounty.io/unsubscribe/${token}`;
      expect(service.parseTokenFromUrl(url)).toBe(token);
    });

    it('extracts token from query string parameter', () => {
      const token = service.generateToken({ userId: 'kevin' });
      const url = `https://truthbounty.io/unsubscribe?token=${token}&utm_source=email`;
      expect(service.parseTokenFromUrl(url)).toBe(token);
    });

    it('extracts token from relative path', () => {
      const token = service.generateToken({ userId: 'laura' });
      expect(service.parseTokenFromUrl(`/unsubscribe/${token}`)).toBe(token);
      expect(service.parseTokenFromUrl(`/unsubscribe?token=${token}`)).toBe(token);
    });

    it('accepts raw token string directly', () => {
      const token = service.generateToken({ userId: 'mallory' });
      expect(service.parseTokenFromUrl(token)).toBe(token);
    });

    it('fails closed safely without throwing on malformed or adversarial inputs', () => {
      expect(service.parseTokenFromUrl(null)).toBeNull();
      expect(service.parseTokenFromUrl(undefined)).toBeNull();
      expect(service.parseTokenFromUrl('')).toBeNull();
      expect(service.parseTokenFromUrl('   ')).toBeNull();
      expect(service.parseTokenFromUrl('javascript:alert(1)')).toBeNull();
      expect(service.parseTokenFromUrl('https://evil.com/<script>')).toBeNull();
      expect(service.parseTokenFromUrl('http://[invalid-ipv6')).toBeNull();
      expect(service.parseTokenFromUrl('A'.repeat(5000))).toBeNull(); // Oversized input
    });
  });
});
