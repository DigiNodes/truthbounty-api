import { UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { AuthService } from './auth.service';

jest.mock('ethers', () => ({
  verifyMessage: jest.fn(),
}));

import { verifyMessage } from 'ethers';

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

  it('generates a fixed-format challenge and persists the nonce with the configured TTL', async () => {
    const address = '0xAbCd';

    const message = await authService.generateChallenge(address);

    expect(message).toMatch(/^Sign in to TruthBounty: [A-Za-z0-9]{32}$/);
    expect(redisService.set).toHaveBeenCalledWith(
      'auth:nonce:0xabcd',
      expect.stringMatching(/^[A-Za-z0-9]{32}$/),
      300,
    );
  });

  it('rejects a challenge response when the signed message does not exactly match the stored nonce', async () => {
    const address = '0xAaBbCc';
    const lower = address.toLowerCase();
    const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const tamperedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123457';

    redisService.get.mockResolvedValueOnce(storedNonce);
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

  it('logs in with an exact challenge message, deletes the nonce, and issues a JWT', async () => {
    const address = '0xAaBbCc';
    const lower = address.toLowerCase();
    const storedNonce = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const challengeMessage = `Sign in to TruthBounty: ${storedNonce}`;

    redisService.get.mockResolvedValueOnce(storedNonce);
    prisma.wallet.findFirst.mockResolvedValueOnce({
      address: lower,
      user: { id: 'user-123' },
    } as any);
    (verifyMessage as jest.Mock).mockReturnValue(address);

    const result = await authService.login({
      address,
      signature: '0xsig',
      message: challengeMessage,
    } as any);

    expect(result).toEqual({
      accessToken: 'signed-token',
      user: {
        id: 'user-123',
        address: lower,
      },
    });
    expect(redisService.del).toHaveBeenCalledWith(`auth:nonce:${lower}`);
    expect(jwtService.sign).toHaveBeenCalledWith({
      address: lower,
      userId: 'user-123',
      sub: 'user-123',
    });
  });

  it('fails challenge generation when Redis rejects the nonce write', async () => {
    redisService.set.mockResolvedValueOnce(false);

    await expect(authService.generateChallenge('0xAbCd')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
