import {
  AuthExceptionFilter,
  AuthErrorCode,
} from './auth-exception.filter';
import {
  HttpException,
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
  // issue-416: all 401 auth failures collapse to constant-shape UNAUTHORIZED
  // externally (granular reason kept in server logs only).

  const testCases: Array<{
    description: string;
    exception: HttpException;
    expectedCode: AuthErrorCode;
  }> = [
    {
      description: 'should collapse invalid signature errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Invalid signature'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse expired session errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Session expired'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse revoked token errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Token has been revoked'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse malformed token errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Malformed token received'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse challenge expired errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Challenge expired'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse challenge not found errors to UNAUTHORIZED',
      exception: new UnauthorizedException('No challenge found'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse refresh invalid errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Refresh token invalid'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
    },
    {
      description: 'should collapse refresh revoked errors to UNAUTHORIZED',
      exception: new UnauthorizedException('Refresh token has been revoked'),
      expectedCode: AuthErrorCode.UNAUTHORIZED,
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
      // issue-416: only 401s collapse to the generic message; other statuses
      // (e.g. 403) preserve their message.
      const expectedMessage =
        exception.getStatus() === 401 ? 'Invalid credentials' : exception.message;
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: expectedCode,
          message: expectedMessage,
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

    // issue-416: 401 object messages collapse to generic constant-shape.
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: AuthErrorCode.UNAUTHORIZED,
        message: 'Invalid credentials',
      }),
    );
  });
});
