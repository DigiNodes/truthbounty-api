import { UnauthorizedException, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('ethers', () => ({
  verifyMessage: jest.fn(),
}));

import { verifyMessage } from 'ethers';

const NONCE_TTL_SECONDS = 300;

function makeRecord(nonce: string, ageSeconds = 0): string {
  return JSON.stringify({ nonce, issuedAt: Date.now() - ageSeconds * 1000 });
}

describe('AuthService', () => {
  let authService: AuthService;
  let jwtService: any;
  let prisma: any;
  let redisService: any;
  let siweService: any;
  let tokenService: any;
  let configService: any;

  beforeEach(() => {
    jwtService = {
      sign: jest.fn().mockReturnValue('signed-token'),
      decode: jest.fn().mockReturnValue({ address: '0xabcd', userId: 'user-123' }),
    };

    prisma = {
      wallet: {
        findFirst: jest.fn().mockResolvedValue(null),
      } as any,
    };

    redisService = {
      set: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(true),
    };

    siweService = {
      buildSiweMessage: jest.fn().mockReturnValue('SIWE message mock'),
      buildLegacyMessage: jest.fn().mockImplementation(
        (nonce: string, app?: string) => `Sign in to ${app || 'TruthBounty'}: ${nonce}`,
      ),
      parseMessage: jest.fn().mockReturnValue(null),
      verifySiwe: jest.fn().mockResolvedValue({ success: false, error: 'NOT_SIWE' }),
      validateProviderSignature: jest.fn().mockReturnValue(true),
    };

    tokenService = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-jti.mock-refresh-value',
        expiresIn: 900,
      }),
      refreshAccessToken: jest.fn().mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-jti.new-refresh-value',
        expiresIn: 900,
      }),
      logout: jest.fn().mockResolvedValue(undefined),
      revokeAllUserTokens: jest.fn().mockResolvedValue(undefined),
      isBlacklisted: jest.fn().mockResolvedValue(false),
    };

    configService = {
      get: jest.fn((key: string, defaultValue: string) => defaultValue),
    };

    authService = new AuthService(
      prisma,
      jwtService,
      redisService,
      siweService,
      tokenService,
      configService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── generateChallenge ────────────────────────────────────────────────────

  describe('generateChallenge', () => {
    it('generates a legacy challenge by default', async () => {
      const address = '0xAbCd';
      const result = await authService.generateChallenge(address);

      expect(result.message).toMatch(/^Sign in to TruthBounty: [A-Za-z0-9]{32}$/);
      expect(result.format).toBe('legacy');

      expect(redisService.set).toHaveBeenCalledWith(
        'auth:nonce:0xabcd',
        expect.stringMatching(/^\{.*"nonce":"[A-Za-z0-9]{32}".*"issuedAt":\d+.*\}$/s),
        NONCE_TTL_SECONDS,
      );
    });

    it('generates a SIWE challenge when domain is provided', async () => {
      const result = await authService.generateChallenge('0xAbCd', {
        domain: 'app.truthbounty.com',
        uri: 'https://app.truthbounty.com',
        chainId: 1,
      });

      expect(result.format).toBe('siwe');
      expect(result.message).toBe('SIWE message mock');
      expect(siweService.buildSiweMessage).toHaveBeenCalled();
    });

    it('fails when Redis rejects the nonce write', async () => {
      redisService.set.mockResolvedValueOnce(false);

      await expect(
        authService.generateChallenge('0xAbCd'),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('persists record with a recent issuedAt timestamp', async () => {
      await authService.generateChallenge('0xAbCd');

      const [, rawJson] = redisService.set.mock.calls[0];
      const parsed = JSON.parse(rawJson);
      expect(typeof parsed.issuedAt).toBe('number');
      expect(Date.now() - parsed.issuedAt).toBeLessThan(2000);
    });
  });

  // ── login — happy path ───────────────────────────────────────────────────

  describe('login', () => {
    it('logs in with valid signature and returns token pair', async () => {
      const address = '0xAaBbCc';
      const lower = address.toLowerCase();
      const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(storedNonce, 0));
      prisma.wallet.findFirst.mockResolvedValueOnce({
        address: lower,
        user: { id: 'user-123' },
      } as any);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      const result = await authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${storedNonce}`,
      } as any);

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBe('mock-jti.mock-refresh-value');
      expect(result.expiresIn).toBe(900);
      expect(result.user).toEqual({ id: 'user-123', address: lower });
      expect(redisService.del).toHaveBeenCalledWith(`auth:nonce:${lower}`);
    });

    it('rejects tampered nonce', async () => {
      const address = '0xAaBbCc';
      const lower = address.toLowerCase();
      const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(storedNonce, 0));
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: WRONGNONCE`,
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(redisService.del).not.toHaveBeenCalled();
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('rejects expired challenge at TTL boundary', async () => {
      const address = '0xDeAdBeEf';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(nonce, NONCE_TTL_SECONDS));
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toThrow('Challenge expired');
    });

    it('rejects stale challenge (Redis TTL desync)', async () => {
      const address = '0xDeAdBeEf';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(nonce, NONCE_TTL_SECONDS + 30));
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toThrow('Challenge expired');
    });

    it('accepts login just inside TTL window', async () => {
      const address = '0xDeAdBeEf';
      const lower = address.toLowerCase();
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(nonce, NONCE_TTL_SECONDS - 1));
      prisma.wallet.findFirst.mockResolvedValueOnce({
        address: lower,
        user: { id: 'uid-1' },
      } as any);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      const result = await authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${nonce}`,
      } as any);

      expect(result.accessToken).toBe('mock-access-token');
    });

    it('rejects corrupt/legacy nonce format', async () => {
      const address = '0xDeAdBeEf';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(nonce);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(redisService.del).toHaveBeenCalledWith(`auth:nonce:${address.toLowerCase()}`);
    });

    it('rejects login when address mismatches recovered address', async () => {
      const address = '0xAaBbCc';
      const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(storedNonce, 0));
      (verifyMessage as jest.Mock).mockReturnValue('0xDifferentAddress');

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${storedNonce}`,
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects login with invalid signature format', async () => {
      (verifyMessage as jest.Mock).mockImplementation(() => {
        throw new Error('invalid signature');
      });

      await expect(
        authService.login({
          address: '0xAbCd',
          signature: 'badsig',
          message: 'some message',
        } as any),
      ).rejects.toThrow('Invalid signature format');
    });

    it('returns token pair when user has no wallet yet (anonymous auth)', async () => {
      const address = '0xNewUser';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.get.mockResolvedValueOnce(makeRecord(nonce, 0));
      prisma.wallet.findFirst.mockResolvedValueOnce(null);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      const result = await authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${nonce}`,
      } as any);

      expect(result.user.id).toBeNull();
      expect(result.accessToken).toBe('mock-access-token');
    });
  });

  // ── refresh ──────────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('should refresh tokens successfully', async () => {
      prisma.wallet.findFirst.mockResolvedValueOnce({
        address: '0xabcd',
        user: { id: 'user-123' },
      } as any);

      const result = await authService.refresh('valid-refresh-token');

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-jti.new-refresh-value');
      expect(result.user).toEqual({ id: 'user-123', address: '0xabcd' });
      expect(tokenService.refreshAccessToken).toHaveBeenCalledWith('valid-refresh-token');
    });

    it('should propagate token service errors', async () => {
      tokenService.refreshAccessToken.mockRejectedValueOnce(
        new UnauthorizedException('Refresh token not found or expired'),
      );

      await expect(
        authService.refresh('bad-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // ── logout ───────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('should logout successfully', async () => {
      await authService.logout({
        address: '0xAbCd',
        jti: 'token-jti',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      expect(tokenService.logout).toHaveBeenCalledWith({
        address: '0xAbCd',
        jti: 'token-jti',
        exp: expect.any(Number),
      });
    });

    it('should reject logout with empty payload', async () => {
      await expect(authService.logout(null)).rejects.toBeInstanceOf(BadRequestException);
      await expect(authService.logout({})).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── revoke ───────────────────────────────────────────────────────────────

  describe('revoke', () => {
    it('should revoke all tokens for an address', async () => {
      await authService.revoke('0xAbCd');

      expect(tokenService.revokeAllUserTokens).toHaveBeenCalledWith('0xAbCd');
    });
  });

  // ── validateToken ────────────────────────────────────────────────────────

  describe('validateToken', () => {
    it('should return user info for a valid non-blacklisted token', async () => {
      tokenService.isBlacklisted.mockResolvedValueOnce(false);
      prisma.wallet.findFirst.mockResolvedValueOnce({
        address: '0xabcd',
        user: { id: 'user-1' },
      } as any);

      const result = await authService.validateToken({
        address: '0xabcd',
        userId: 'user-1',
        sub: 'user-1',
        jti: 'test-jti',
      });

      expect(result).toEqual({
        address: '0xabcd',
        userId: 'user-1',
        user: { id: 'user-1' },
        jti: 'test-jti',
        sub: 'user-1',
      });
    });

    it('should return null for a blacklisted token', async () => {
      tokenService.isBlacklisted.mockResolvedValueOnce(true);

      const result = await authService.validateToken({
        address: '0xabcd',
        jti: 'blacklisted-jti',
      });

      expect(result).toBeNull();
    });

    it('should fall back to payload address when wallet not found', async () => {
      tokenService.isBlacklisted.mockResolvedValueOnce(false);
      prisma.wallet.findFirst.mockResolvedValueOnce(null);

      const result = await authService.validateToken({
        address: '0xabcd',
        userId: null,
        sub: '0xabcd',
      });

      expect(result).toEqual({
        address: '0xabcd',
        userId: null,
        user: null,
        jti: undefined,
        sub: '0xabcd',
      });
    });
  });
});
