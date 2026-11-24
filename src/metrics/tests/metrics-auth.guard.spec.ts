import {
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { MetricsAuthGuard } from '../metrics-auth.guard';

describe('MetricsAuthGuard', () => {
  let guard: MetricsAuthGuard;
  let configService: { get: jest.Mock };
  let context: ExecutionContext;

  const buildContext = (authorization?: string) => {
    const request: { headers: Record<string, string | undefined> } = {
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
  });
});
