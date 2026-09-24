import {
  AuthExceptionFilter,
  AuthErrorCode,
} from './auth-exception.filter';
import {
  HttpException,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ArgumentsHost,
} from '@nestjs/common';

describe('AuthExceptionFilter', () => {
  let filter: AuthExceptionFilter;

  beforeEach(() => {
    filter = new AuthExceptionFilter();
  });

  function createMockHost(url: string = '/auth/login'): ArgumentsHost {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    return {
      switchToHttp: () => ({
        getResponse: () => ({
          status,
          json,
        }),
        getRequest: () => ({
          url,
          method: 'POST',
        }),
      }),
    } as unknown as ArgumentsHost;
  }

  // ── Error code mapping ───────────────────────────────────────────────────

  const testCases: Array<{
    description: string;
    exception: HttpException;
    expectedCode: AuthErrorCode;
  }> = [
    {
      description: 'should map invalid signature errors to INVALID_SIGNATURE',
      exception: new UnauthorizedException('Invalid signature'),
      expectedCode: AuthErrorCode.INVALID_SIGNATURE,
    },
    {
      description: 'should map expired session errors to EXPIRED_SESSION',
      exception: new UnauthorizedException('Session expired'),
      expectedCode: AuthErrorCode.EXPIRED_SESSION,
    },
    {
      description: 'should map revoked token errors to REVOKED_TOKEN',
      exception: new UnauthorizedException('Token has been revoked'),
      expectedCode: AuthErrorCode.REVOKED_TOKEN,
    },
    {
      description: 'should map malformed token errors to MALFORMED_TOKEN',
      exception: new UnauthorizedException('Malformed token received'),
      expectedCode: AuthErrorCode.MALFORMED_TOKEN,
    },
    {
      description: 'should map challenge expired errors to CHALLENGE_EXPIRED',
      exception: new UnauthorizedException('Challenge expired'),
      expectedCode: AuthErrorCode.CHALLENGE_EXPIRED,
    },
    {
      description: 'should map challenge not found errors to CHALLENGE_NOT_FOUND',
      exception: new UnauthorizedException('No challenge found'),
      expectedCode: AuthErrorCode.CHALLENGE_NOT_FOUND,
    },
    {
      description: 'should map refresh invalid errors to REFRESH_INVALID',
      exception: new UnauthorizedException('Refresh token invalid'),
      expectedCode: AuthErrorCode.REFRESH_INVALID,
    },
    {
      description: 'should map refresh revoked errors to REFRESH_REVOKED',
      exception: new UnauthorizedException('Refresh token has been revoked'),
      expectedCode: AuthErrorCode.REFRESH_REVOKED,
    },
    {
      description: 'should map forbidden errors to FORBIDDEN',
      exception: new ForbiddenException('Not allowed'),
      expectedCode: AuthErrorCode.FORBIDDEN,
    },
    {
      description: 'should map generic 401s to UNAUTHORIZED',
      exception: new UnauthorizedException('Something went wrong'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
  ];

  testCases.forEach(({ description, exception, expectedCode }) => {
    it(description, () => {
      const host = createMockHost();
      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const json = response.status().json;
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: expectedCode,
          statusCode: exception.getStatus(),
          timestamp: expect.any(String),
          path: '/auth/login',
        }),
      );
    });
  });

  // ── Response structure ───────────────────────────────────────────────────

  it('should include all required fields in the response', () => {
    const exception = new BadRequestException('Invalid signature format');
    const host = createMockHost('/auth/login');

    filter.catch(exception, host);

    const response = host.switchToHttp().getResponse();
    const json = response.status().json;

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'Bad Request',
        code: AuthErrorCode.INVALID_SIGNATURE,
        message: 'Invalid signature format',
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        path: '/auth/login',
      }),
    );
  });

  it('should handle exception response with object message', () => {
    const exception = new UnauthorizedException({
      message: ['Invalid signature', 'Address mismatch'],
    } as any);
    const host = createMockHost();

    filter.catch(exception, host);

    const response = host.switchToHttp().getResponse();
    const json = response.status().json;

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Invalid signature',
      }),
    );
  });
});
