import { UnauthorizedException } from '@nestjs/common';
import {
  CapabilityToken,
  IssueCapabilityOptions,
  TokenService,
} from './token.service';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomBytes: jest.fn((size: number) => Buffer.from('a'.repeat(size))),
  };
});

describe('TokenService — capability token TTL (issue #845)', () => {
  const HARD_MAX = 300;

  const baseOptions: IssueCapabilityOptions = {
    audience: 'truthbounty-api',
    subject: '0xAbCd',
    capability: 'mutation:update-profile',
    resource: 'profile:123',
    chain: 'eip155:10',
    release: 'release-1',
    deployment: 'deployment-1',
    artifact: 'artifact-1',
  };

  let service: TokenService;
  let jwtService: { sign: jest.Mock; verify: jest.Mock };
  let configService: { get: jest.Mock };
  let redisService: { set: jest.Mock; get: jest.Mock; del: jest.Mock };
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jwtService = {
      sign: jest.fn().mockReturnValue('capability.jwt.value'),
      verify: jest.fn(),
    };
    configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    redisService = {
      set: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(true),
    };
    service = new TokenService(
      jwtService as never,
      configService as never,
      redisService as never,
    );
    const logger = (service as any).logger;
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  const issue = (ttlSeconds?: number): Promise<CapabilityToken> =>
    service.issueCapabilityToken(
      ttlSeconds === undefined
        ? { ...baseOptions }
        : { ...baseOptions, ttlSeconds },
    );

  function expectSingleEffectiveTtl(
    result: CapabilityToken,
    expected: number,
  ): void {
    expect(result.expiresIn).toBe(expected);

    expect(jwtService.sign).toHaveBeenCalledTimes(1);
    expect(jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'capability', nonce: result.nonce }),
      expect.objectContaining({ expiresIn: expected }),
    );

    expect(redisService.set).toHaveBeenCalledTimes(1);
    expect(redisService.set).toHaveBeenCalledWith(
      `auth:capability_nonce:${result.nonce}`,
      expect.any(String),
      expected,
    );

    expect(logSpy).toHaveBeenCalledWith(
      'Capability token issued',
      expect.objectContaining({ nonce: result.nonce, ttlSeconds: expected }),
    );
  }

  describe('accepted TTL values', () => {
    it('uses the hard maximum when ttlSeconds is omitted', async () => {
      expectSingleEffectiveTtl(await issue(), HARD_MAX);
    });

    it('honors the minimum positive TTL of one second', async () => {
      expectSingleEffectiveTtl(await issue(1), 1);
    });

    it('raises a sub-second request to the minimum of one second', async () => {
      expectSingleEffectiveTtl(await issue(0.5), 1);
    });

    it('honors the hard maximum when requested exactly', async () => {
      expectSingleEffectiveTtl(await issue(HARD_MAX), HARD_MAX);
    });

    it('clamps a just-above-maximum request to the hard maximum', async () => {
      expectSingleEffectiveTtl(await issue(HARD_MAX + 1), HARD_MAX);
    });

    it('clamps a day-long request to the hard maximum', async () => {
      expectSingleEffectiveTtl(await issue(86_400), HARD_MAX);
    });

    it('floors fractional requests to whole seconds', async () => {
      expectSingleEffectiveTtl(await issue(12.9), 12);
    });
  });

  describe('invalid TTL values fail closed', () => {
    it.each<[string, number]>([
      ['zero', 0],
      ['negative', -30],
      ['NaN', NaN],
      ['positive infinity', Infinity],
      ['negative infinity', -Infinity],
    ])('rejects %s without issuing a token', async (_label, ttlSeconds) => {
      await expect(issue(ttlSeconds)).rejects.toThrow(UnauthorizedException);
      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Capability issuance failed [invalid-ttl]',
      );
    });

    it('rejects a non-number value supplied at runtime', async () => {
      const options = {
        ...baseOptions,
        ttlSeconds: '60',
      } as unknown as IssueCapabilityOptions;

      await expect(service.issueCapabilityToken(options)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });
  });

  describe('declared option is authoritative', () => {
    it('ignores the undeclared ttdSeconds property', async () => {
      const options = {
        ...baseOptions,
        ttdSeconds: 5,
      } as IssueCapabilityOptions & { ttdSeconds: number };

      expectSingleEffectiveTtl(
        await service.issueCapabilityToken(options),
        HARD_MAX,
      );
    });

    it('prefers ttlSeconds when both properties are present', async () => {
      const options = {
        ...baseOptions,
        ttlSeconds: 45,
        ttdSeconds: 5,
      } as IssueCapabilityOptions & { ttdSeconds: number };

      expectSingleEffectiveTtl(
        await service.issueCapabilityToken(options),
        45,
      );
    });
  });

  describe('replay nonce persistence', () => {
    it('does not return a token when the nonce record cannot be persisted', async () => {
      redisService.set.mockResolvedValueOnce(false);

      await expect(issue(60)).rejects.toThrow(UnauthorizedException);
      expect(redisService.set).toHaveBeenCalledTimes(1);
      expect(jwtService.sign).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        'Capability issuance failed [nonce-persist]',
      );
    });
  });
});
