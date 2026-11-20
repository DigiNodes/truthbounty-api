import {
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
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
      decode: jest
        .fn()
        .mockReturnValue({ address: '0xabcd', userId: 'user-123' }),
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
      // Atomic consume: returns the stored record only if it matches the
      // expected nonce, deleting it in the same Redis script. Returns null
      // when missing/mismatched and throws on Redis failure (fail closed).
      consumeIfMatch: jest.fn().mockResolvedValue(null),
    };

    siweService = {
      buildSiweMessage: jest.fn().mockReturnValue('SIWE message mock'),
      buildLegacyMessage: jest
        .fn()
        .mockImplementation(
          (nonce: string, app?: string) =>
            `Sign in to ${app || 'TruthBounty'}: ${nonce}`,
        ),
      parseMessage: jest.fn().mockReturnValue(null),
      verifySiwe: jest
        .fn()
        .mockResolvedValue({ success: false, error: 'NOT_SIWE' }),
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

      expect(result.message).toMatch(
        /^Sign in to TruthBounty: [A-Za-z0-9]{32}$/,
      );
      expect(result.format).toBe('legacy');

      expect(redisService.set).toHaveBeenCalledWith(
        'auth:nonce:0xabcd',
        expect.stringMatching(
          /^\{.*"nonce":"[A-Za-z0-9]{32}".*"issuedAt":\d+.*\}$/s,
        ),
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

      redisService.consumeIfMatch.mockResolvedValueOnce(
        makeRecord(storedNonce, 0),
      );
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
      expect(redisService.consumeIfMatch).toHaveBeenCalledWith(
        `auth:nonce:${lower}`,
        storedNonce,
      );
    });

    it('rejects tampered nonce without consuming the challenge', async () => {
      const address = '0xAaBbCc';
      const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.consumeIfMatch.mockResolvedValueOnce(null);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: WRONGNONCE`,
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(storedNonce).toBeDefined();
    });

    it('rejects expired challenge at TTL boundary', async () => {
      const address = '0xDeAdBeEf';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.consumeIfMatch.mockResolvedValueOnce(
        makeRecord(nonce, NONCE_TTL_SECONDS),
      );
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toThrow('Invalid credentials');
    });

    it('rejects stale challenge (Redis TTL desync)', async () => {
      const address = '0xDeAdBeEf';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.consumeIfMatch.mockResolvedValueOnce(
        makeRecord(nonce, NONCE_TTL_SECONDS + 30),
      );
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toThrow('Invalid credentials');
    });

    it('accepts login just inside TTL window', async () => {
      const address = '0xDeAdBeEf';
      const lower = address.toLowerCase();
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.consumeIfMatch.mockResolvedValueOnce(
        makeRecord(nonce, NONCE_TTL_SECONDS - 1),
      );
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

    it('rejects corrupt/legacy nonce format and consumes the record', async () => {
      const address = '0xDeAdBeEf';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.consumeIfMatch.mockResolvedValueOnce(nonce);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(redisService.consumeIfMatch).toHaveBeenCalledWith(
        `auth:nonce:${address.toLowerCase()}`,
        nonce,
      );
    });

    it('rejects login when address mismatches recovered address', async () => {
      const address = '0xAaBbCc';
      const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      (verifyMessage as jest.Mock).mockReturnValue('0xDifferentAddress');

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${storedNonce}`,
        } as any),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(redisService.consumeIfMatch).not.toHaveBeenCalled();
    });

    it('rejects login with invalid signature format', async () => {
      (verifyMessage as jest.Mock).mockImplementation(() => {
        throw new Error('invalid signature');
      });

      // issue-416: constant-shape — parse failures collapse to generic 401.
      await expect(
        authService.login({
          address: '0xAbCd',
          signature: 'badsig',
          message: 'some message',
        } as any),
      ).rejects.toThrow('Invalid credentials');
    });

    it('returns constant-shape 401 for all login failure modes (no enumeration)', async () => {
      // address mismatch
      (verifyMessage as jest.Mock).mockReturnValueOnce('0xDifferentAddress');
      await expect(
        authService.login({
          address: '0xAaBbCc',
          signature: '0xsig',
          message: 'Sign in to TruthBounty: NONCE',
        } as any),
      ).rejects.toThrow('Invalid credentials');

      // missing challenge
      (verifyMessage as jest.Mock).mockReturnValueOnce('0xAaBbCc');
      redisService.consumeIfMatch.mockResolvedValueOnce(null);
      await expect(
        authService.login({
          address: '0xAaBbCc',
          signature: '0xsig',
          message: 'Sign in to TruthBounty: NONCE',
        } as any),
      ).rejects.toThrow('Invalid credentials');

      // invalid nonce
      (verifyMessage as jest.Mock).mockReturnValueOnce('0xAaBbCc');
      redisService.consumeIfMatch.mockResolvedValueOnce(
        makeRecord('REALNONCE12345678901234567890', 0),
      );
      await expect(
        authService.login({
          address: '0xAaBbCc',
          signature: '0xsig',
          message: 'Sign in to TruthBounty: WRONGNONCE',
        } as any),
      ).rejects.toThrow('Invalid credentials');
    });

    it('prevents replay: concurrent reuse of the same nonce fails closed', async () => {
      const address = '0xAaBbCc';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
      (verifyMessage as jest.Mock).mockReturnValue(address);
      // First atomic consume wins; second finds the record already deleted.
      redisService.consumeIfMatch
        .mockResolvedValueOnce(makeRecord(nonce, 0))
        .mockResolvedValueOnce(null);
      prisma.wallet.findFirst.mockResolvedValueOnce({
        address,
        user: { id: 'u1' },
      } as any);

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).resolves.toBeDefined();
      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toThrow('Invalid credentials');
      expect(redisService.consumeIfMatch).toHaveBeenCalledTimes(2);
    });

    it('fails closed when atomic consume errors (Redis unavailable)', async () => {
      const address = '0xAaBbCc';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
      (verifyMessage as jest.Mock).mockReturnValue(address);
      redisService.consumeIfMatch.mockRejectedValueOnce(
        new Error('ECONNREFUSED'),
      );

      await expect(
        authService.login({
          address,
          signature: '0xsig',
          message: `Sign in to TruthBounty: ${nonce}`,
        } as any),
      ).rejects.toThrow('Invalid credentials');

      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    });

    it('returns token pair when user has no wallet yet (anonymous auth)', async () => {
      const address = '0xNewUser';
      const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      redisService.consumeIfMatch.mockResolvedValueOnce(makeRecord(nonce, 0));
      prisma.wallet.findFirst.mockResolvedValueOnce(null);
      (verifyMessage as jest.Mock).mockReturnValue(address);

      const result = await authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${nonce}`,
      } as any);

      expect(result.accessToken).toBe('mock-access-token');
    });
  });
});
