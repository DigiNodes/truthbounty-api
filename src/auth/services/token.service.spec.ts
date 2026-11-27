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
            lastActivityAt: Date.now(),
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
            accessJti: 'access-jti',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
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

    it('should use atomic compare-and-delete for session consumption', async () => {
      const { createHash } = require('crypto');
      const refreshJti = 'a'.repeat(32);
      const tokenValue = `${refreshJti}.${Buffer.alloc(48, 1).toString('base64url')}`;
      const tokenHash = createHash('sha256').update(tokenValue).digest('hex');
      const sessionData = JSON.stringify({
        jti: refreshJti,
        tokenHash,
        address: '0xabcd',
        userId: 'user-1',
        accessJti: 'old-access-jti',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      redisService.get
        .mockResolvedValueOnce(null) // blacklist check
        .mockResolvedValueOnce(sessionData);

      await service.refreshAccessToken(tokenValue);

      // Verify the Lua script uses exact value comparison
      expect(redisService.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
        1,
        `auth:session:${refreshJti}`,
        sessionData,
      );
    });

    it('should fail closed when session consumption returns 0 (concurrent use)', async () => {
      const { createHash } = require('crypto');
      const refreshJti = 'a'.repeat(32);
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
            lastActivityAt: Date.now(),
          }),
        );

      // Simulate concurrent consumption - Lua script returns 0
      redisService.eval.mockResolvedValueOnce(0);

      await expect(service.refreshAccessToken(tokenValue)).rejects.toThrow(
        'Invalid credentials',
      );
    });

    it('should fail closed when blacklist write fails after consumption', async () => {
      const { createHash } = require('crypto');
      const refreshJti = 'a'.repeat(32);
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
            lastActivityAt: Date.now(),
          }),
        );

      redisService.eval.mockResolvedValueOnce(1); // consumption succeeds
      redisService.set.mockResolvedValueOnce(false); // blacklist write fails

      await expect(service.refreshAccessToken(tokenValue)).rejects.toThrow(
        'Unable to rotate authentication session',
      );
    });

    it('should validate session metadata structure before accepting', async () => {
      const { createHash } = require('crypto');
      const refreshJti = 'a'.repeat(32);
      const tokenValue = `${refreshJti}.${Buffer.alloc(48, 1).toString('base64url')}`;
      const tokenHash = createHash('sha256').update(tokenValue).digest('hex');

      // Invalid session metadata - missing required fields
      redisService.get
        .mockResolvedValueOnce(null) // blacklist check
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: refreshJti,
            tokenHash,
            // Missing address, userId, accessJti
          }),
        );

      await expect(service.refreshAccessToken(tokenValue)).rejects.toThrow(
        'Invalid credentials',
      );
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

    it('should return false when audience does not match', async () => {
      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: 'wrong-audience',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(false);
      expect(redisService.get).not.toHaveBeenCalled(); // fail fast
    });

    it('should return false when issuer does not match', async () => {
      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: 'truthbounty-api',
        iss: 'wrong-issuer',
      });

      expect(result).toBe(false);
      expect(redisService.get).not.toHaveBeenCalled(); // fail fast
    });

    it('should return false when subject does not match userId', async () => {
      const result = await service.validateAccessToken({
        sub: 'wrong-subject',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: 'truthbounty-api',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(false);
      expect(redisService.get).not.toHaveBeenCalled(); // fail fast
    });

    it('should validate wallet-only tokens correctly', async () => {
      redisService.get.mockResolvedValueOnce(null);

      const address = `0x${'a'.repeat(40)}`;
      const result = await service.validateAccessToken({
        sub: address.toLowerCase(),
        address,
        userId: null,
        jti: 'test-jti',
        type: 'access',
        aud: 'truthbounty-api',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(true);
    });

    it('should return false for invalid address format', async () => {
      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: 'not-an-address',
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: 'truthbounty-api',
        iss: 'truthbounty-api',
      });

      expect(result).toBe(false);
      expect(redisService.get).not.toHaveBeenCalled(); // fail fast
    });

    it('should handle array audience correctly', async () => {
      redisService.get.mockResolvedValueOnce(null);

      const result = await service.validateAccessToken({
        sub: 'user-1',
        address: `0x${'a'.repeat(40)}`,
        userId: 'user-1',
        jti: 'test-jti',
        type: 'access',
        aud: ['truthbounty-api', 'other-service'],
        iss: 'truthbounty-api',
      });

      expect(result).toBe(true);
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
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash1',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'refresh-jti-2',
            accessJti: 'access-jti-2',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash2',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        );

      await service.logout({
        address: '0xabcd',
        jti: 'access-jti',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      // Access token blacklisted
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:access-jti',
        '1',
        expect.any(Number),
      );

      // Both refresh and access JTIs blacklisted for each session
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:refresh-jti-1',
        '1',
        expect.any(Number),
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:access-jti-1',
        '1',
        expect.any(Number),
      );

      // Refresh sessions deleted
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

    it('should fail closed when blacklist write fails', async () => {
      redisService.set.mockResolvedValueOnce(false);

      await expect(
        service.logout({
          address: '0xabcd',
          jti: 'access-jti',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).rejects.toThrow('Unable to revoke authentication token');
    });

    it('should work without jti (revoke all sessions only)', async () => {
      redisService.get.mockResolvedValueOnce(null);

      await service.logout({
        address: '0xabcd',
      });

      expect(redisService.set).not.toHaveBeenCalled();
    });
  });

  // ── revokeAllUserTokens ──────────────────────────────────────────────────

  describe('revokeAllUserTokens', () => {
    it('should revoke all refresh tokens for a user', async () => {
      redisService.get
        .mockResolvedValueOnce(JSON.stringify(['jti-1', 'jti-2', 'jti-3']))
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'jti-1',
            accessJti: 'access-1',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash1',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'jti-2',
            accessJti: 'access-2',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash2',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'jti-3',
            accessJti: 'access-3',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash3',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        );

      await service.revokeAllUserTokens('0xAbCd');

      // All refresh and access tokens blacklisted
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:jti-1',
        '1',
        expect.any(Number),
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:access-1',
        '1',
        expect.any(Number),
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:jti-2',
        '1',
        expect.any(Number),
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'auth:blacklist:access-2',
        '1',
        expect.any(Number),
      );

      // All sessions deleted
      expect(redisService.del).toHaveBeenCalledWith('auth:session:jti-1');
      expect(redisService.del).toHaveBeenCalledWith('auth:session:jti-2');
      expect(redisService.del).toHaveBeenCalledWith('auth:session:jti-3');

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

    it('should fail closed when blacklist write fails', async () => {
      redisService.get
        .mockResolvedValueOnce(JSON.stringify(['jti-1']))
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'jti-1',
            accessJti: 'access-1',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash1',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        );

      redisService.set.mockResolvedValueOnce(false);

      await expect(service.revokeAllUserTokens('0xAbCd')).rejects.toThrow(
        'Unable to revoke authentication session',
      );
    });

    it('should fail closed when session deletion fails', async () => {
      redisService.get
        .mockResolvedValueOnce(JSON.stringify(['jti-1']))
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'jti-1',
            accessJti: 'access-1',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash1',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        );

      redisService.del.mockResolvedValueOnce(false);

      await expect(service.revokeAllUserTokens('0xAbCd')).rejects.toThrow(
        'Unable to remove authentication session',
      );
    });

    it('should fail closed when index deletion fails', async () => {
      redisService.get
        .mockResolvedValueOnce(JSON.stringify(['jti-1']))
        .mockResolvedValueOnce(
          JSON.stringify({
            jti: 'jti-1',
            accessJti: 'access-1',
            address: '0xabcd',
            userId: 'user-1',
            tokenHash: 'hash1',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
          }),
        );

      redisService.del
        .mockResolvedValueOnce(true) // session deletion succeeds
        .mockResolvedValueOnce(false); // index deletion fails

      await expect(service.revokeAllUserTokens('0xAbCd')).rejects.toThrow(
        'Unable to remove authentication session index',
      );
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

      it('concurrent requests: exactly one consumes the nonce', async () => {
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
        const storedBinding = JSON.stringify({
          aud: binding.audience,
          sub: binding.subject.toLowerCase(),
          capability: binding.capability,
          resource: binding.resource,
          chain: binding.chain,
          release: binding.release,
          deployment: binding.deployment,
          artifact: binding.artifact,
        });
        const basePayload = {
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

        // Both concurrent requests pass JWT verification and binding checks.
        jwtService.verify
          .mockReturnValueOnce(basePayload)
          .mockReturnValueOnce(basePayload);

        // Both pass the revocation check.
        // Both read the nonce binding (GET returns the stored value).
        redisService.get
          .mockResolvedValueOnce(null)           // req1 revocation check
          .mockResolvedValueOnce(storedBinding)  // req1 nonce binding read
          .mockResolvedValueOnce(null)           // req2 revocation check
          .mockResolvedValueOnce(storedBinding); // req2 nonce binding read

        // The Lua compare-and-delete: first call returns 1 (consumed), second returns 0 (already gone).
        redisService.eval
          .mockResolvedValueOnce(1)  // first request wins
          .mockResolvedValueOnce(0); // second request loses (replay)

        const [r1, r2] = await Promise.allSettled([
          service.validateAndConsumeCapabilityToken(issued.token, binding),
          service.validateAndConsumeCapabilityToken(issued.token, binding),
        ]);

        const successes = [r1, r2].filter((r) => r.status === 'fulfilled');
        const failures  = [r1, r2].filter((r) => r.status === 'rejected');
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect((failures[0] as PromiseRejectedResult).reason.message).toBe(
          'Invalid credentials',
        );
      });

      it('fails closed when the eval (nonce consumption) throws (Redis unavailable)', async () => {
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
        const storedBinding = JSON.stringify({
          aud: binding.audience,
          sub: binding.subject.toLowerCase(),
          capability: binding.capability,
          resource: binding.resource,
          chain: binding.chain,
          release: binding.release,
          deployment: binding.deployment,
          artifact: binding.artifact,
        });
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
          .mockResolvedValueOnce(null)           // revocation check
          .mockResolvedValueOnce(storedBinding); // nonce binding read

        // Simulate Redis going down at the consumption step.
        redisService.eval.mockRejectedValueOnce(
          new Error('Redis unavailable (Fail Closed)'),
        );

        await expect(
          service.validateAndConsumeCapabilityToken(issued.token, binding),
        ).rejects.toThrow('Invalid credentials');
      });

      it('wrong binding fields are rejected before the nonce is consumed', async () => {
        // Mismatched resource: binding check rejects before any nonce GET.
        jwtService.verify.mockReturnValueOnce({
          aud: 'claims-service',
          sub: '0xactor',
          capability: 'claim:update',
          resource: 'claim:other-resource',
          nonce: 'some-nonce',
          chain: '10',
          release: 'release-1',
          deployment: 'deployment-1',
          artifact: 'artifact-1',
          type: 'capability',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 60,
        });
        jest.clearAllMocks();
        redisService.get.mockResolvedValue(null);
        redisService.eval.mockResolvedValue(1);

        await expect(
          service.validateAndConsumeCapabilityToken('token', {
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

        // The eval (nonce consumption) must not have been called.
        expect(redisService.eval).not.toHaveBeenCalled();
      });

      it('missing nonce (nonce not in Redis) fails closed without calling eval', async () => {
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
          .mockResolvedValueOnce(null)  // revocation check
          .mockResolvedValueOnce(null); // nonce missing (already consumed or never stored)

        await expect(
          service.validateAndConsumeCapabilityToken(issued.token, binding),
        ).rejects.toThrow('Invalid credentials');

        // eval must not be called when nonce is missing.
        expect(redisService.eval).not.toHaveBeenCalled();
      });

      it('corrupt nonce JSON fails closed without calling eval', async () => {
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
          .mockResolvedValueOnce(null)           // revocation check
          .mockResolvedValueOnce('{not-valid-json'); // corrupt nonce

        await expect(
          service.validateAndConsumeCapabilityToken(issued.token, binding),
        ).rejects.toThrow('Invalid credentials');
        expect(redisService.eval).not.toHaveBeenCalled();
      });
    });
  });
});
