import { UnauthorizedException } from '@nestjs/common';
import { Wallet } from 'ethers';
import { AuthService } from './auth.service';
import { SiweService } from './services/siwe.service';

const configValues: Record<string, string> = {
  SIWE_DOMAIN: 'app.truthbounty.com',
  SIWE_ORIGIN: 'https://app.truthbounty.com',
  SIWE_SUPPORTED_CHAIN_IDS: '1,10',
  SIWE_ALLOWED_ORIGINS: '',
  SIWE_ALLOWED_DOMAINS: '',
  AUTH_NONCE_TTL_MS: String(5 * 60 * 1000),
};

const configService = {
  get: (key: string, fallback?: string) => configValues[key] ?? fallback,
} as any;

class MemoryRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  readonly consume = jest.fn(async (key: string, expected: string) => {
    const entry = this.store.get(key);
    if (this.failConsume || !entry || entry.value !== expected) {
      return false;
    }
    this.store.delete(key);
    return true;
  });
  failConsume = false;
  failGet = false;

  async set(key: string, value: string, ttl: number): Promise<boolean> {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return true;
  }

  async get(key: string): Promise<string | null> {
    if (this.failGet) {
      throw new Error('redis unavailable');
    }
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
}

describe('AuthService wallet login format dispatch', () => {
  const wallet = Wallet.createRandom();
  const foreignWallet = Wallet.createRandom();
  const principal = wallet.address.toLowerCase();
  let redis: MemoryRedis;
  let siweService: SiweService;
  let authService: AuthService;
  let tokenService: { generateTokenPair: jest.Mock };
  let prisma: { wallet: { findFirst: jest.Mock } };

  beforeEach(() => {
    redis = new MemoryRedis();
    siweService = new SiweService(configService);
    tokenService = {
      generateTokenPair: jest.fn(async (address: string, userId: string | null) => ({
        accessToken: `access:${address}:${userId}`,
        refreshToken: 'refresh',
        expiresIn: 900,
      })),
    };
    prisma = {
      wallet: {
        findFirst: jest.fn(async () => ({
          address: principal,
          user: { id: 'user-1' },
        })),
      },
    };
    authService = new AuthService(
      prisma as any,
      {} as any,
      redis as any,
      siweService,
      tokenService as any,
      configService,
    );
  });

  async function issueSiwe(options?: { domain?: string; uri?: string; chainId?: number }) {
    const result = await authService.generateChallenge(wallet.address, {
      domain: options?.domain ?? configValues.SIWE_DOMAIN,
      uri: options?.uri ?? configValues.SIWE_ORIGIN,
      chainId: options?.chainId ?? 10,
    });
    expect(result.format).toBe('siwe');
    return {
      message: result.message,
      signature: await wallet.signMessage(result.message),
    };
  }

  async function issueLegacy() {
    const result = await authService.generateChallenge(wallet.address);
    expect(result.format).toBe('legacy');
    return {
      message: result.message,
      signature: await wallet.signMessage(result.message),
    };
  }

  function replaceLine(message: string, prefix: string, value: string): string {
    return message
      .split('\n')
      .map((line) => (line.startsWith(prefix) ? `${prefix}${value}` : line))
      .join('\n');
  }

  async function signAs(
    message: string,
    signer: { signMessage: (message: string) => Promise<string> },
  ): Promise<string> {
    return signer.signMessage(message);
  }

  it('accepts a valid SIWE challenge and binds the verified address to lookup and tokens', async () => {
    const { message, signature } = await issueSiwe();

    const result = await authService.login({
      address: wallet.address.toLowerCase(),
      signature,
      message,
    } as any);

    expect(result.user).toEqual({ id: 'user-1', address: principal });
    expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
      where: { address: principal },
      include: { user: true },
    });
    expect(tokenService.generateTokenPair).toHaveBeenCalledWith(principal, 'user-1');
    expect(redis.consume).toHaveBeenCalledWith(
      `auth:nonce:${principal}`,
      expect.stringContaining('"nonce"'),
    );
    expect(redis.store.size).toBe(0);
  });

  it('passes the issued domain, origin, chain, statement and chain policy to the verifier', async () => {
    const { message, signature } = await issueSiwe({
      domain: 'app.truthbounty.com',
      uri: 'https://app.truthbounty.com/login',
      chainId: 10,
    });
    const verifySpy = jest.spyOn(siweService, 'verifySiwe');

    await authService.login({ address: wallet.address, signature, message } as any);

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy.mock.calls[0][0]).toMatchObject({
      message,
      signature,
      expectedDomain: 'app.truthbounty.com',
      expectedOrigin: 'https://app.truthbounty.com',
      expectedChainId: 10,
      expectedStatement:
        'Sign in to TruthBounty — decentralized news verification',
      supportedChainIds: [1, 10],
    });
    verifySpy.mockRestore();
  });

  it('rejects replay of a consumed SIWE challenge', async () => {
    const { message, signature } = await issueSiwe();
    await expect(
      authService.login({ address: wallet.address, signature, message } as any),
    ).resolves.toBeDefined();

    await expect(
      authService.login({ address: wallet.address, signature, message } as any),
    ).rejects.toThrow('Invalid credentials');
    expect(tokenService.generateTokenPair).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['domain', (m: string) => m.replace('app.truthbounty.com', 'evil.example')],
    ['uri origin', (m: string) => replaceLine(m, 'URI: ', 'https://evil.example')],
    ['chain id', (m: string) => replaceLine(m, 'Chain ID: ', '1')],
    ['statement', (m: string) => m.replace('decentralized news verification', 'other purpose')],
    ['nonce', (m: string) => replaceLine(m, 'Nonce: ', 'OTHERNONCE1234567890')],
    ['issued at', (m: string) => replaceLine(m, 'Issued At: ', '2020-01-01T00:00:00.000Z')],
    ['expiration', (m: string) => replaceLine(m, 'Expiration Time: ', '2020-01-01T00:00:00.000Z')],
  ])('rejects a signed SIWE message with a tampered %s', async (_field, tamper) => {
    const { message } = await issueSiwe();
    const tampered = tamper(message);
    const signature = await signAs(tampered, wallet);

    await expect(
      authService.login({ address: wallet.address, signature, message: tampered } as any),
    ).rejects.toThrow('Invalid credentials');
    expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
  });

  it('rejects a wrong signer even when the submitted address is the challenge owner', async () => {
    const { message } = await issueSiwe();
    const signature = await signAs(message, foreignWallet);

    await expect(
      authService.login({ address: wallet.address, signature, message } as any),
    ).rejects.toThrow('Invalid credentials');
  });

  it('does not downgrade a malformed SIWE message to legacy verification', async () => {
    const legacy = await issueLegacy();
    const storedNonce = legacy.message.split(': ').pop() as string;
    const malformed = [
      'app.truthbounty.com wants you to sign in with your Ethereum account:',
      wallet.address,
      '',
      'Sign in to TruthBounty — decentralized news verification',
      '',
      `Nonce: ${storedNonce}`,
    ].join('\n');
    const verifySpy = jest.spyOn(siweService, 'verifySiwe');
    const signature = await signAs(malformed, wallet);

    await expect(
      authService.login({ address: wallet.address, signature, message: malformed } as any),
    ).rejects.toThrow('Invalid credentials');
    expect(verifySpy).toHaveBeenCalled();
    expect(redis.store.size).toBe(1);
    verifySpy.mockRestore();
  });

  it('ignores a mismatched client-side format hint', async () => {
    const siwe = await issueSiwe();
    await expect(
      authService.login({
        address: wallet.address,
        signature: siwe.signature,
        message: siwe.message,
        format: 'legacy',
      } as any),
    ).resolves.toBeDefined();

    const legacy = await issueLegacy();
    await expect(
      authService.login({
        address: wallet.address,
        signature: legacy.signature,
        message: legacy.message,
        format: 'siwe',
      } as any),
    ).resolves.toBeDefined();
  });

  it('keeps legacy challenge/login backward compatible with a generic 401 on failure', async () => {
    const legacy = await issueLegacy();
    await expect(
      authService.login({
        address: wallet.address,
        signature: legacy.signature,
        message: legacy.message,
      } as any),
    ).resolves.toBeDefined();

    await expect(
      authService.login({
        address: wallet.address,
        signature: legacy.signature,
        message: legacy.message.replace(legacy.message.split(': ').pop() as string, 'WRONGNONCE'),
      } as any),
    ).rejects.toThrow('Invalid credentials');
  });

  it('fails closed when the shared atomic consumption contract fails', async () => {
    const { message, signature } = await issueSiwe();
    redis.failConsume = true;

    await expect(
      authService.login({ address: wallet.address, signature, message } as any),
    ).rejects.toThrow('Invalid credentials');
    expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(1);
  });

  it('fails closed when Redis cannot be read', async () => {
    const { message, signature } = await issueSiwe();
    redis.failGet = true;

    await expect(
      authService.login({ address: wallet.address, signature, message } as any),
    ).rejects.toThrow('Invalid credentials');
    expect(tokenService.generateTokenPair).not.toHaveBeenCalled();
  });

  it('allows exactly one of two concurrent SIWE logins with the same challenge', async () => {
    const { message, signature } = await issueSiwe();
    const dto = { address: wallet.address, signature, message } as any;

    const results = await Promise.allSettled([
      authService.login(dto),
      authService.login(dto),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(tokenService.generateTokenPair).toHaveBeenCalledTimes(1);
  });

  it('returns a constant-shape 401 for a wrong SIWE signer and a wrong legacy signature', async () => {
    const siwe = await issueSiwe();
    const legacy = await issueLegacy();
    const failures = [
      authService.login({
        address: wallet.address,
        signature: await signAs(siwe.message, foreignWallet),
        message: siwe.message,
      } as any),
      authService.login({
        address: wallet.address,
        signature: '0xbad',
        message: legacy.message,
      } as any),
    ];

    for (const failure of failures) {
      await expect(failure).rejects.toMatchObject({
        message: 'Invalid credentials',
        status: 401,
      });
    }
  });

  it('is an UnauthorizedException for every rejected SIWE login', async () => {
    const { message } = await issueSiwe();
    const signature = await signAs(
      replaceLine(message, 'Chain ID: ', '9999'),
      wallet,
    );

    await expect(
      authService.login({
        address: wallet.address,
        signature,
        message: replaceLine(message, 'Chain ID: ', '9999'),
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
