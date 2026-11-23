import { TokenService } from './token.service';

// Mock crypto to avoid real randomness in tests (for deterministic output)
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  let seed = 0;
  return {
    ...actual,
    randomBytes: jest.fn((size: number) => {
      seed = (seed % 250) + 1;
      return Buffer.alloc(size, seed);
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
      eval: jest.fn().mockResolvedValue(1),
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
      expect(result.refreshToken).toMatch(/^[a-f0-9]{32}\.[A-Za-z0-9_-]{64}$/);
      expect(result.expiresIn).toBeGreaterThan(0);

      const [sessionKey, rawSession] = redisService.set.mock.calls[0];
      expect(sessionKey).toMatch(/^auth:session:/);
      const session = JSON.parse(rawSession);
      expect(session.tokenHash).toBe(
        require('crypto')
          .createHash('sha256')
          .update(result.refreshToken)
          .digest('hex'),
      );
      expect(session.tokenHash).not.toBe(result.refreshToken);
      expect(redisService.eval).toHaveBeenCalledWith(
        expect.stringContaining('table.insert'),
        1,
        'auth:user_sessions:0xabcd',
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
          address: `0x${'a'.repeat(40)}`,
          userId: 'user-1',
          type: 'access',
          jti: expect.any(String),
        }),
        expect.objectContaining({
          expiresIn: expect.any(Number),
          audience: 'truthbounty-api',
          issuer: 'truthbounty-api',
        }),
      );
    });

    it('does not return a pair if session metadata cannot be persisted', async () => {
      redisService.set.mockResolvedValueOnce(false);

      await expect(
        service.generateTokenPair('0xAbCd', 'user-1'),
      ).rejects.toThrow('Unable to persist authentication session');
      expect(redisService.eval).not.toHaveBeenCalled();
    });

    it('rolls back session metadata when the user index write fails', async () => {
      redisService.eval.mockRejectedValueOnce(new Error('Redis unavailable'));

      await expect(
        service.generateTokenPair('0xAbCd', 'user-1'),
      ).rejects.toThrow('Unable to persist authentication session');
      expect(redisService.del).toHaveBeenCalledWith(
        expect.stringMatching(/^auth:session:/),
      );
    });
  });

  // ── refreshAccessToken ───────────────────────────────────────────────────

  describe('refreshAccessToken', () => {
    it('should successfully refresh with a valid refresh token', async () => {
      const { createHash } = require('crypto');

      // Simulate a stored refresh token
      const refreshJti = 'a'.repeat(32); // 16 bytes hex
      const tokenValue = `${refreshJti}.${Buffer.alloc(48, 1).toString('base64url')}`;
      const tokenHash = createHash('sha256').update(tokenValue).digest('hex');

      redisService.get
        .mockResolvedValueOnce(null) // blacklist check
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: refreshJti,
            tokenHash,
            address: '0xabcd',
            userId: 'user-1',
            accessJti: 'old-access-jti',
            createdAt: Date.now(),
          }),
        );

      const result = await service.refreshAccessToken(tokenValue);

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBeDefined();

      // Old refresh token should be deleted and blacklisted
      expect(redisService.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('DEL', KEYS[1])"),
        1,
        `auth:session:${refreshJti}`,
        expect.any(String),
      );
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^auth:blacklist:/),
        '1',
        expect.any(Number),
      );
    });

    it('should reject a malformed refresh token', async () => {
      // issue-416: constant-shape generic 401 (was 'Malformed refresh token').
      await expect(service.refreshAccessToken('bad-format')).rejects.toThrow(
        'Invalid credentials',
      );
    });

    it('should reject a blacklisted refresh token', async () => {
      const token =
        `${'a'.repeat(32)}.${Buffer.alloc(48, 1).toString('base64url')}`;
      redisService.get.mockResolvedValueOnce('1'); // blacklist hit

      await expect(service.refreshAccessToken(token)).rejects.toThrow(
        'Invalid credentials',
      );
    });

    it('should reject an expired/missing refresh token', async () => {
      redisService.get
        .mockResolvedValueOnce(null) // not blacklisted
        .mockResolvedValueOnce(null); // not found in storage

      await expect(
        service.refreshAccessToken(
          `${'a'.repeat(32)}.${Buffer.alloc(48, 1).toString('base64url')}`,
        ),
      ).rejects.toThrow(
        'Invalid credentials',
      );
    });

    it('should revoke all tokens on hash mismatch (potential theft)', async () => {
      const { createHash } = require('crypto');
      const tokenValue = 'different'.repeat(6);
      const tokenHash = createHash('sha256')
        .update('original_value')
        .digest('hex');
      const refreshJti = 'a'.repeat(32);

      redisService.get
        .mockResolvedValueOnce(null) // not blacklisted
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: refreshJti,
            tokenHash,
            address: '0xabcd',
            userId: 'user-1',
          }),
        );

      // issue-416: external shape is generic, but fail-closed revocation remains.
      await expect(
        service.refreshAccessToken(`${refreshJti}.${tokenValue}`),
      ).rejects.toThrow('Invalid credentials');
    });

    it('returns constant-shape 401 across refresh failure modes (no enumeration)', async () => {
      for (const raw of ['no-dot', 'a.b.c', 'jti.']) {
        await expect(service.refreshAccessToken(raw)).rejects.toThrow(
          'Invalid credentials',
        );
        jest.clearAllMocks();
        redisService.get.mockResolvedValue(null);
        redisService.set.mockResolvedValue(true);
        redisService.del.mockResolvedValue(true);
      }
    });
  });

  // ── validateAccessToken ──────────────────────────────────────────────────

  describe('validateAccessToken', () => {
    it('should return true for a valid, non-blacklisted access token', async () => {
      redisService.get.mockResolvedValueOnce(null); // not blacklisted

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: 'truthbounty-api',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(true);
    });

    it('should return false for a blacklisted token', async () => {
      redisService.get.mockResolvedValueOnce('1'); // blacklisted

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: 'truthbounty-api',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(false);
    });

    it('should return false for a refresh token used as access token', async () => {
      redisService.get.mockResolvedValueOnce(null);

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'refresh',
        aud: 'truthbounty-api',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(false);
    });
  });

  // ── logout ───────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('should blacklist access token and revoke refresh tokens', async () => {
      redisService.get
        .mockResolvedValueOnce(JSON.stringify(['refresh-jti-1', 'refresh-jti-2']))
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'refresh-jti-1',
            accessJti: 'access-jti-1',
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'refresh-jti-2',
            accessJti: 'access-jti-2',
          }),
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
      expect(redisService.del).toHaveBeenCalledWith(
        'auth:session:refresh-jti-1',
      );
      expect(redisService.del).toHaveBeenCalledWith(
        'auth:session:refresh-jti-2',
      );

      // User refresh list deleted
      expect(redisService.del).toHaveBeenCalledWith(
        'auth:user_sessions:0xabcd',
      );
    });
  });

  // ── revokeAllUserTokens ──────────────────────────────────────────────────

  describe('revokeAllUserTokens', () => {
    it('should revoke all refresh tokens for a user', async () => {
      redisService.get
        .mockResolvedValueOnce(JSON.stringify(['jti-1', 'jti-2', 'jti-3']))
        .mockResolvedValueOnce(
          JSON.stringify({ jti: 'jti-1', accessJti: 'access-1' }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({ jti: 'jti-2', accessJti: 'access-2' }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({ jti: 'jti-3', accessJti: 'access-3' }),
        );

      await service.revokeAllUserTokens('0xAbCd');

      // All refresh tokens deleted
      expect(redisService.del).toHaveBeenCalledWith('auth:session:jti-1');
      expect(redisService.del).toHaveBeenCalledWith('auth:session:jti-2');
      expect(redisService.del).toHaveBeenCalledWith('auth:session:jti-3');

      // Blacklisted
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:jti-1',
        '1',
        expect.any(Number),
      );

      // User list deleted
      expect(redisService.del).toHaveBeenCalledWith(
        'auth:user_sessions:0xabcd',
      );
    });

    it('should handle no existing refresh tokens', async () => {
      redisService.get.mockResolvedValueOnce(null);

      await service.revokeAllUserTokens('0xAbCd');

      expect(redisService.del).not.toHaveBeenCalled();
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

    describe('capability token validation', () => {
      it('consumes an exact scoped capability only through its dedicated validator', async () => {
        const binding = {
          audience: 'claims-service',
          subject: '0xActor',
          capability: 'claim:update',
          resource: 'claim:123',
          chain: '10',
          release: 'release-1',
          deployment: 'deployment-1',
          artifact: 'artifact-1',
        };
        const issued = await service.issueCapabilityToken(binding);
        const payload = {
          aud: binding.audience,
          sub: binding.subject.toLowerCase(),
          capability: binding.capability,
          resource: binding.resource,
          chain: binding.chain,
          release: binding.release,
          deployment: binding.deployment,
          artifact: binding.artifact,
          nonce: issued.nonce,
          type: 'capability' as const,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + issued.expiresIn,
        };
        jwtService.verify.mockReturnValueOnce(payload);
        redisService.get
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(
            JSON.stringify({
              aud: payload.aud,
              sub: payload.sub,
              capability: payload.capability,
              resource: payload.resource,
              chain: payload.chain,
              release: payload.release,
              deployment: payload.deployment,
              artifact: payload.artifact,
            }),
          );

        await expect(
          service.validateAndConsumeCapabilityToken(issued.token, binding),
        ).resolves.toEqual(payload);
        expect(redisService.eval).toHaveBeenCalledWith(
          expect.stringContaining("redis.call('DEL', KEYS[1])"),
          1,
          `auth:capability_nonce:${issued.nonce}`,
          expect.any(String),
        );
      });

      it('rejects a capability with any mismatched binding', async () => {
        jwtService.verify.mockReturnValueOnce({
          aud: 'claims-service',
          sub: '0xactor',
          capability: 'claim:update',
          resource: 'claim:other',
          nonce: 'nonce',
          chain: '10',
          release: 'release-1',
          deployment: 'deployment-1',
          artifact: 'artifact-1',
          type: 'capability',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
        });

        await expect(
          service.validateAndConsumeCapabilityToken('capability-jwt', {
            audience: 'claims-service',
            subject: '0xActor',
            capability: 'claim:update',
            resource: 'claim:123',
            chain: '10',
            release: 'release-1',
            deployment: 'deployment-1',
            artifact: 'artifact-1',
          }),
        ).rejects.toThrow('Invalid credentials');
        expect(redisService.get).not.toHaveBeenCalled();
      });
    });
  });
});
