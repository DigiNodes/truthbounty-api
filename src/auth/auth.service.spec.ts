import { UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('ethers', () => ({
  verifyMessage: jest.fn(),
}));

import { verifyMessage } from 'ethers';

const NONCE_TTL_SECONDS = 300; // must mirror AuthService.NONCE_TTL_SECONDS

function makeRecord(nonce: string, ageSeconds = 0): string {
  return JSON.stringify({ nonce, issuedAt: Date.now() - ageSeconds * 1000 });
}

describe('AuthService', () => {
  let authService: AuthService;
  let jwtService: any;
  let prisma: any;
  let redisService: any;

  beforeEach(() => {
    jwtService = {
      sign: jest.fn().mockReturnValue('signed-token'),
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

    authService = new AuthService(prisma, jwtService, redisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── generateChallenge ────────────────────────────────────────────────────

  it('generates a fixed-format challenge and persists a JSON record with the configured TTL', async () => {
    const address = '0xAbCd';

    const message = await authService.generateChallenge(address);

    expect(message).toMatch(/^Sign in to TruthBounty: [A-Za-z0-9]{32}$/);

    expect(redisService.set).toHaveBeenCalledWith(
      'auth:nonce:0xabcd',
      expect.stringMatching(/^\{.*"nonce":"[A-Za-z0-9]{32}".*"issuedAt":\d+.*\}$/s),
      NONCE_TTL_SECONDS,
    );

    // issuedAt must be a recent Unix timestamp (within 2 s of now)
    const [, rawJson] = redisService.set.mock.calls[0];
    const parsed = JSON.parse(rawJson);
    expect(typeof parsed.issuedAt).toBe('number');
    expect(Date.now() - parsed.issuedAt).toBeLessThan(2000);
  });

  it('fails challenge generation when Redis rejects the nonce write', async () => {
    redisService.set.mockResolvedValueOnce(false);

    await expect(authService.generateChallenge('0xAbCd')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  // ── login — happy path ───────────────────────────────────────────────────

  it('logs in with an exact challenge message, deletes the nonce, and issues a JWT', async () => {
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

    expect(result).toEqual({
      accessToken: 'signed-token',
      user: { id: 'user-123', address: lower },
    });
    expect(redisService.del).toHaveBeenCalledWith(`auth:nonce:${lower}`);
    expect(jwtService.sign).toHaveBeenCalledWith({
      address: lower,
      userId: 'user-123',
      sub: 'user-123',
    });
  });

  // ── login — nonce mismatch ───────────────────────────────────────────────

  it('rejects a challenge response when the signed message does not exactly match the stored nonce', async () => {
    const address = '0xAaBbCc';
    const lower = address.toLowerCase();
    const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const tamperedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123457';

    redisService.get.mockResolvedValueOnce(makeRecord(storedNonce, 0));
    (verifyMessage as jest.Mock).mockReturnValue(address);

    await expect(
      authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${tamperedNonce}`,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(redisService.del).not.toHaveBeenCalled();
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(redisService.get).toHaveBeenCalledWith(`auth:nonce:${lower}`);
  });

  // ── login — TTL desync scenarios (BE-182) ───────────────────────────────

  it('rejects login when the challenge was issued exactly at the TTL boundary (app-layer expiry)', async () => {
    const address = '0xDeAdBeEf';
    const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

    // issuedAt is exactly NONCE_TTL_SECONDS ago — considered expired
    redisService.get.mockResolvedValueOnce(makeRecord(nonce, NONCE_TTL_SECONDS));
    (verifyMessage as jest.Mock).mockReturnValue(address);

    await expect(
      authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${nonce}`,
      } as any),
    ).rejects.toThrow('Challenge expired');

    expect(redisService.del).toHaveBeenCalledWith(`auth:nonce:${address.toLowerCase()}`);
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('rejects login when the challenge is older than the TTL (Redis TTL would have matched but app clock says expired)', async () => {
    const address = '0xDeAdBeEf';
    const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

    // Simulate Redis TTL desync: key still present in Redis but issuedAt is stale
    redisService.get.mockResolvedValueOnce(makeRecord(nonce, NONCE_TTL_SECONDS + 30));
    (verifyMessage as jest.Mock).mockReturnValue(address);

    await expect(
      authService.login({
        address,
        signature: '0xsig',
        message: `Sign in to TruthBounty: ${nonce}`,
      } as any),
    ).rejects.toThrow('Challenge expired');

    expect(redisService.del).toHaveBeenCalledWith(`auth:nonce:${address.toLowerCase()}`);
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('accepts login when the challenge is just inside the TTL window', async () => {
    const address = '0xDeAdBeEf';
    const lower = address.toLowerCase();
    const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

    // 1 second before the boundary
    redisService.get.mockResolvedValueOnce(makeRecord(nonce, NONCE_TTL_SECONDS - 1));
    prisma.wallet.findFirst.mockResolvedValueOnce({ address: lower, user: { id: 'uid-1' } } as any);
    (verifyMessage as jest.Mock).mockReturnValue(address);

    const result = await authService.login({
      address,
      signature: '0xsig',
      message: `Sign in to TruthBounty: ${nonce}`,
    } as any);

    expect(result.accessToken).toBe('signed-token');
  });

  it('rejects login when the stored value is not valid JSON (corrupt / legacy nonce)', async () => {
    const address = '0xDeAdBeEf';
    const nonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

    // A legacy raw-string nonce (pre-fix format) is invalid JSON
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
    expect(jwtService.sign).not.toHaveBeenCalled();
  });
});
