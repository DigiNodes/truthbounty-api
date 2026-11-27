import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Wallet } from 'ethers';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { SiweService } from './services/siwe.service';
import { TokenService } from './services/token.service';

function createRedisStore() {
  const values = new Map<string, string>();
  return {
    values,
    set: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
      return true;
    }),
    get: jest.fn(async (key: string) => values.get(key) ?? null),
    del: jest.fn(async (key: string) => {
      values.delete(key);
      return true;
    }),
    eval: jest.fn(
      async (script: string, _keyCount: number, ...args: Array<string | number>) => {
        const key = String(args[0]);
        if (script.includes('table.insert(ids, ARGV[1])')) {
          const ids = JSON.parse(values.get(key) ?? '[]') as string[];
          if (!ids.includes(String(args[1]))) ids.push(String(args[1]));
          values.set(key, JSON.stringify(ids));
          return 1;
        }
        if (script.includes('local updated = {}')) {
          const ids = JSON.parse(values.get(key) ?? '[]') as string[];
          const remaining = ids.filter((id) => id !== String(args[1]));
          if (remaining.length) values.set(key, JSON.stringify(remaining));
          else values.delete(key);
          return 1;
        }
        if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
          if (values.get(key) !== String(args[1])) return 0;
          values.delete(key);
          return 1;
        }
        throw new Error('Unexpected Redis script in auth integration test');
      },
    ),
  };
}

function createAuthHarness() {
  const configValues = {
    AUTH_NONCE_TTL_MS: 300_000,
    SIWE_DOMAIN: 'app.truthbounty.com',
    SIWE_ORIGIN: 'https://app.truthbounty.com',
    SIWE_ALLOWED_DOMAINS: 'app.truthbounty.com',
    SIWE_ALLOWED_ORIGINS: 'https://app.truthbounty.com',
    SIWE_SUPPORTED_CHAIN_IDS: '10',
    SIWE_EXPECTED_STATEMENT: 'Sign in to TruthBounty V2.',
    JWT_ACCESS_AUDIENCE: 'truthbounty-api',
    JWT_ISSUER: 'truthbounty-api',
    JWT_EXPIRATION: '15m',
    REFRESH_TOKEN_EXPIRATION: '7d',
  };
  const configService = new ConfigService(configValues);
  const jwtService = new JwtService({ secret: 'auth-integration-test-secret' });
  const redisService = createRedisStore();
  const prisma = {
    wallet: {
      findFirst: jest.fn(async ({ where }: { where: { address: string } }) => ({
        address: where.address,
        user: { id: 'user-123', role: 'contributor' },
      })),
    },
  };
  const siweService = new SiweService(configService);
  const tokenService = new TokenService(jwtService, configService, redisService);
  const authService = new AuthService(
    prisma as any,
    jwtService,
    redisService as any,
    siweService,
    tokenService,
    configService,
  );

  return { authService, jwtService, redisService, tokenService };
}

describe('AuthService wallet login integration', () => {
  it('accepts a generated and signed SIWE challenge through the strict verifier', async () => {
    const { authService, jwtService, redisService } = createAuthHarness();
    const wallet = Wallet.createRandom();
    const { message, format } = await authService.generateChallenge(
      wallet.address,
      {
        domain: 'app.truthbounty.com',
        uri: 'https://app.truthbounty.com',
        chainId: 10,
      },
    );
    const signature = await wallet.signMessage(message);

    const login = await authService.login({
      address: wallet.address,
      signature,
      message,
    });

    expect(format).toBe('siwe');
    expect(login.user.address).toBe(wallet.address.toLowerCase());
    expect(login.user.id).toBe('user-123');
    expect(jwtService.verify(login.accessToken, {
      audience: 'truthbounty-api',
      issuer: 'truthbounty-api',
    })).toEqual(
      expect.objectContaining({
        type: 'access',
        address: wallet.address.toLowerCase(),
        userId: 'user-123',
      }),
    );
    expect(redisService.values.has(`auth:nonce:${wallet.address.toLowerCase()}`)).toBe(
      false,
    );
  });

  it('issues a hashed refresh session and rotates it through the real TokenService', async () => {
    const { authService, redisService } = createAuthHarness();
    const wallet = Wallet.createRandom();
    const { message } = await authService.generateChallenge(wallet.address);
    const signature = await wallet.signMessage(message);

    const login = await authService.login({
      address: wallet.address,
      signature,
      message,
    });
    const firstSession = Array.from(redisService.values.entries()).find(([key]) =>
      key.startsWith('auth:session:'),
    );
    expect(firstSession).toBeDefined();
    const stored = JSON.parse(firstSession![1]);
    expect(stored.tokenHash).toBe(
      createHash('sha256').update(login.refreshToken).digest('hex'),
    );
    expect(stored.tokenHash).not.toBe(login.refreshToken);

    const rotated = await authService.refresh(login.refreshToken);
    expect(rotated.refreshToken).not.toBe(login.refreshToken);
    const rotatedSession = Array.from(redisService.values.entries()).find(
      ([key]) => key.startsWith('auth:session:'),
    );
    expect(rotatedSession).toBeDefined();
    expect(JSON.parse(rotatedSession![1]).tokenHash).toBe(
      createHash('sha256').update(rotated.refreshToken).digest('hex'),
    );
  });
});
