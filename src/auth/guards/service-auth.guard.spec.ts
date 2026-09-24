import { ServiceAuthGuard } from './service-auth.guard';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ExecutionContext } from '@nestjs/common';

describe('ServiceAuthGuard', () => {
  let guard: ServiceAuthGuard;
  let configService: any;

  const VALID_API_KEY = 'sk-service-secret-key-12345';

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue(VALID_API_KEY),
    };
    guard = new ServiceAuthGuard(configService);
  });

  function createMockContext(headers: Record<string, string>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  // ── Valid requests ───────────────────────────────────────────────────────

  it('should allow access with a valid API key', () => {
    const context = createMockContext({
      'x-service-api-key': VALID_API_KEY,
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  // ── Missing key ──────────────────────────────────────────────────────────

  it('should reject when no API key header is present', () => {
    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Service API key required');
  });

  // ── Invalid key ──────────────────────────────────────────────────────────

  it('should reject an invalid API key', () => {
    const context = createMockContext({
      'x-service-api-key': 'wrong-key',
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid service API key');
  });

  it('should reject a subtly different API key (different case)', () => {
    const context = createMockContext({
      'x-service-api-key': VALID_API_KEY.toUpperCase(),
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  // ── Missing config ───────────────────────────────────────────────────────

  it('should reject when SERVICE_API_KEY is not configured', () => {
    configService.get.mockReturnValue('');
    const noKeyGuard = new ServiceAuthGuard(configService);
    const context = createMockContext({
      'x-service-api-key': 'anything',
    });

    expect(() => noKeyGuard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => noKeyGuard.canActivate(context)).toThrow('Service authentication not configured');
  });
});
