import {
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqualUtf8 } from '../../common/utils/timing-safe.util';
import { MetricsAuthGuard } from '../metrics-auth.guard';

describe('MetricsAuthGuard', () => {
  let guard: MetricsAuthGuard;
  let configService: { get: jest.Mock };
  let context: ExecutionContext;

  const buildContext = (authorization?: string | string[]) => {
    const request: {
      headers: { authorization?: string | string[] };
    } = {
      headers: {},
    };
    if (authorization !== undefined) {
      request.headers.authorization = authorization;
    }
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    configService = { get: jest.fn() };
    guard = new MetricsAuthGuard(
      configService as unknown as ConstructorParameters<
        typeof MetricsAuthGuard
      >[0],
    );
    context = buildContext();
  });

  const setEnv = (values: Record<string, string | undefined>) => {
    configService.get.mockImplementation((key: string) => values[key]);
  };

  describe('disable mode (METRICS_ENABLED)', () => {
    it('throws NotFoundException when METRICS_ENABLED=false and no token is set', () => {
      setEnv({ METRICS_ENABLED: 'false' });

      expect(() => guard.canActivate(context)).toThrow(NotFoundException);
    });

    it('throws NotFoundException even when a valid bearer token is presented', () => {
      setEnv({ METRICS_ENABLED: 'false', METRICS_TOKEN: 'secret-token' });
      context = buildContext('Bearer secret-token');

      expect(() => guard.canActivate(context)).toThrow(NotFoundException);
    });

    it('returns NotFound (not Unauthorized) when disabled and the header is missing', () => {
      setEnv({ METRICS_ENABLED: 'false', METRICS_TOKEN: 'secret-token' });

      expect(() => guard.canActivate(context)).toThrow(NotFoundException);
      expect(() => guard.canActivate(context)).not.toThrow(
        UnauthorizedException,
      );
    });

    it.each(['false', 'FALSE', ' False '])(
      'treats METRICS_ENABLED=%p as disabled',
      (value) => {
        setEnv({ METRICS_ENABLED: value });

        expect(() => guard.canActivate(context)).toThrow(NotFoundException);
      },
    );

    it.each(['true', 'TRUE', '1', 'yes', '', undefined])(
      'keeps metrics enabled for METRICS_ENABLED=%p',
      (value) => {
        setEnv({ METRICS_ENABLED: value });

        expect(guard.canActivate(context)).toBe(true);
      },
    );
  });

  describe('token authentication while enabled', () => {
    it('allows access when no METRICS_TOKEN is configured', () => {
      setEnv({ METRICS_TOKEN: undefined });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('allows access with a valid bearer token', () => {
      setEnv({ METRICS_TOKEN: 'secret-token' });
      context = buildContext('Bearer secret-token');

      expect(guard.canActivate(context)).toBe(true);
    });

    it('rejects a missing authorization header', () => {
      setEnv({ METRICS_TOKEN: 'secret-token' });

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('rejects a malformed authorization scheme', () => {
      setEnv({ METRICS_TOKEN: 'secret-token' });
      context = buildContext('Basic secret-token');

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('rejects an invalid token', () => {
      setEnv({ METRICS_TOKEN: 'secret-token' });
      context = buildContext('Bearer wrong-token');

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('rejects a token with a different byte length', () => {
      setEnv({ METRICS_TOKEN: 'secret-token' });
      context = buildContext('Bearer short');

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it.each([
      'Bearer secret-token extra',
      'Bearer  secret-token',
      'bearer secret-token',
      'Bearer secret-token,other-token',
    ])('rejects malformed or ambiguous bearer values: %p', (authorization) => {
      setEnv({ METRICS_TOKEN: 'secret-token' });
      context = buildContext(authorization);

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('rejects repeated Authorization values represented as an array', () => {
      setEnv({ METRICS_TOKEN: 'secret-token' });
      context = buildContext(['Bearer secret-token', 'Bearer secret-token']);

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('does not expose either token in authentication failures', () => {
      const configured = 'configured-metrics-secret';
      const supplied = 'supplied-metrics-secret';
      setEnv({ METRICS_TOKEN: configured });
      context = buildContext(`Bearer ${supplied}`);

      let error: unknown;
      try {
        guard.canActivate(context);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(String(error)).not.toContain(configured);
      expect(String(error)).not.toContain(supplied);
    });

    it('uses the shared UTF-8 helper safely for equal and unequal byte lengths', () => {
      expect(timingSafeEqualUtf8('metrics-✓', 'metrics-✓')).toBe(true);
      expect(timingSafeEqualUtf8('metrics-✓', 'metrics-✗')).toBe(false);
      expect(() =>
        timingSafeEqualUtf8('short', 'much-longer-token'),
      ).not.toThrow();
    });
  });
});
