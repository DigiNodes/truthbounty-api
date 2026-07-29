import { TokenService } from './token.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

// Mock crypto to avoid real randomness in tests (for deterministic output)
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: jest.fn((size: number) => {
      return Buffer.from('a'.repeat(size));
    }),
  };
});

describe('TokenService', () => {
  let service: TokenService;
  let jwtService: any;
  let configService: any;
  let redisService: any;

  beforeEach(() => {
    jwtService = {
      sign: jest.fn().mockReturnValue('mock-access-token'),
      decode: jest.fn(),
      verify: jest.fn(),
    };

    configService = {
      get: jest.fn((key: string, defaultValue: string) => defaultValue),
    };

    redisService = {
      set: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(true),
    };

    service = new TokenService(jwtService, configService, redisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── generateTokenPair ────────────────────────────────────────────────────

  describe('generateTokenPair', () => {
    it('should generate access and refresh tokens', async () => {
      const result = await service.generateTokenPair('0xAbCd', 'user-1');

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toMatch(/^[a-f0-9]+\.[A-Za-z0-9_-]+$/);
      expect(result.expiresIn).toBeGreaterThan(0);

      // Should store refresh token in Redis
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^auth:refresh:/),
        expect.any(String),
        expect.any(Number),
      );

      // Should store user refresh list in Redis
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:user_refresh:0xabcd',
        expect.any(String),
        expect.any(Number),
      );
    });

    it('should work with null userId (wallet-only login)', async () => {
      const result = await service.generateTokenPair('0xAbCd', null);
      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBeDefined();
    });

    it('should sign JWT with correct payload structure', async () => {
      await service.generateTokenPair('0xAbCd', 'user-1');

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          address: '0xabcd',
          userId: 'user-1',
          type: 'access',
          jti: expect.any(String),
        }),
        expect.objectContaining({
          expiresIn: expect.any(Number),
        }),
      );
    });
  });

  // ── refreshAccessToken ───────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('should successfully refresh with a valid refresh token', async () => {
      const { createHash } = require('crypto');

      // Simulate a stored refresh token
      const tokenValue = 'aaaa'.repeat(12); // 48 chars base64url
      const tokenHash = createHash('sha256').update(tokenValue).digest('hex');
      const refreshJti = 'a'.repeat(32); // 16 bytes hex

      redisService.get.mockResolvedValueOnce(null) // blacklist check
        .mockResolvedValueOnce(JSON.stringify({
          jti: refreshJti,
          tokenHash,
          address: '0xabcd',
          userId: 'user-1',
          accessJti: 'old-access-jti',
          createdAt: Date.now(),
        }));

      const result = await service.refreshAccessToken(`${refreshJti}.${tokenValue}`);

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBeDefined();

      // Old refresh token should be deleted and blacklisted
      expect(redisService.del).toHaveBeenCalledWith(`auth:refresh:${refreshJti}`);
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^auth:blacklist:/),
        '1',
        expect.any(Number),
      );
    });

    it('should reject a malformed refresh token', async () => {
      await expect(
        service.refreshAccessToken('bad-format'),
      ).rejects.toThrow('Malformed refresh token');
    });

    it('should reject a blacklisted refresh token', async () => {
      redisService.get.mockResolvedValueOnce('1'); // blacklist hit

      await expect(
        service.refreshAccessToken('abc.def'),
      ).rejects.toThrow('Refresh token has been revoked');
    });

    it('should reject an expired/missing refresh token', async () => {
      redisService.get.mockResolvedValueOnce(null) // not blacklisted
        .mockResolvedValueOnce(null); // not found in storage

      await expect(
        service.refreshAccessToken('abc.def'),
      ).rejects.toThrow('Refresh token not found or expired');
    });

    it('should revoke all tokens on hash mismatch (potential theft)', async () => {
      const { createHash } = require('crypto');
      const tokenValue = 'different'.repeat(6);
      const tokenHash = createHash('sha256').update('original_value').digest('hex');
      const refreshJti = 'a'.repeat(32);

      redisService.get.mockResolvedValueOnce(null) // not blacklisted
        .mockResolvedValueOnce(JSON.stringify({
          jti: refreshJti,
          tokenHash,
          address: '0xabcd',
          userId: 'user-1',
        }));

      await expect(
        service.refreshAccessToken(`${refreshJti}.${tokenValue}`),
      ).rejects.toThrow('Refresh token mismatch');
    });
  });

  // ── validateAccessToken ──────────────────────────────────────────────────

  describe('validateAccessToken', () => {
    it('should return true for a valid, non-blacklisted access token', async () => {
      redisService.get.mockResolvedValueOnce(null); // not blacklisted

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: '0xabcd',
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
      });

      expect(result).toBe(true);
    });

    it('should return false for a blacklisted token', async () => {
      redisService.get.mockResolvedValueOnce('1'); // blacklisted

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: '0xabcd',
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
      });

      expect(result).toBe(false);
    });

    it('should return false for a refresh token used as access token', async () => {
      redisService.get.mockResolvedValueOnce(null);

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: '0xabcd',
        userId: 'user-1',
        jti: 'test-jti',
        type: 'refresh',
      });

      expect(result).toBe(false);
    });
  });

  // ── logout ───────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('should blacklist access token and revoke refresh tokens', async () => {
      // revokeAllUserTokens calls get() to fetch user's refresh token list
      redisService.get.mockResolvedValueOnce(
        JSON.stringify(['refresh-jti-1', 'refresh-jti-2']),
      );

      await service.logout({
        sub: 'user-1',
        address: '0xabcd',
        userId: 'user-1',
        jti: 'access-jti',
        type: 'access',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      // Access token blacklisted
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:access-jti',
        '1',
        expect.any(Number),
      );

      // Refresh tokens revoked
      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:refresh-jti-1');
      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:refresh-jti-2');

      // User refresh list deleted
      expect(redisService.del).toHaveBeenCalledWith('auth:user_refresh:0xabcd');
    });
  });

  // ── revokeAllUserTokens ──────────────────────────────────────────────────

  describe('revokeAllUserTokens', () => {
    it('should revoke all refresh tokens for a user', async () => {
      redisService.get.mockResolvedValueOnce(JSON.stringify(['jti-1', 'jti-2', 'jti-3']));

      await service.revokeAllUserTokens('0xAbCd');

      // All refresh tokens deleted
      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:jti-1');
      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:jti-2');
      expect(redisService.del).toHaveBeenCalledWith('auth:refresh:jti-3');

      // Blacklisted
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:jti-1', '1', expect.any(Number),
      );

      // User list deleted
      expect(redisService.del).toHaveBeenCalledWith('auth:user_refresh:0xabcd');
    });

    it('should handle no existing refresh tokens', async () => {
      redisService.get.mockResolvedValueOnce(null);

      await service.revokeAllUserTokens('0xAbCd');

      // Should still clean up the user list key
      expect(redisService.del).toHaveBeenCalledWith('auth:user_refresh:0xabcd');
    });
  });

  // ── isBlacklisted ────────────────────────────────────────────────────────

  describe('isBlacklisted', () => {
    it('should return true for a blacklisted token', async () => {
      redisService.get.mockResolvedValueOnce('1');
      const result = await service.isBlacklisted('some-jti');
      expect(result).toBe(true);
    });

    it('should return false for a non-blacklisted token', async () => {
      redisService.get.mockResolvedValueOnce(null);
      const result = await service.isBlacklisted('some-jti');
      expect(result).toBe(false);
    });
  });
});
