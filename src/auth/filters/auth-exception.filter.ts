import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Standardized authentication error codes.
 * Maps to the error codes specified in the assignment requirements.
 */
export enum AuthErrorCode {
  INVALID_SIGNATURE = 'AUTH_INVALID_SIGNATURE',
  EXPIRED_SESSION = 'AUTH_EXPIRED_SESSION',
  REVOKED_TOKEN = 'AUTH_REVOKED_TOKEN',
  MALFORMED_TOKEN = 'AUTH_MALFORMED_TOKEN',
  UNAUTHORIZED = 'AUTH_UNAUTHORIZED',
  CHALLENGE_EXPIRED = 'AUTH_CHALLENGE_EXPIRED',
  CHALLENGE_NOT_FOUND = 'AUTH_CHALLENGE_NOT_FOUND',
  REFRESH_INVALID = 'AUTH_REFRESH_INVALID',
  REFRESH_REVOKED = 'AUTH_REFRESH_REVOKED',
  SESSION_FIXATION = 'AUTH_SESSION_FIXATION',
  RATE_LIMITED = 'AUTH_RATE_LIMITED',
  FORBIDDEN = 'AUTH_FORBIDDEN',
}

/**
 * Maps HTTP exceptions to standardized auth error codes.
 */
function mapExceptionToErrorCode(
  exception: HttpException,
): AuthErrorCode {
  const message = exception.message?.toLowerCase() || '';
  const status = exception.getStatus();

  // Order matters: more specific patterns first
  if (message.includes('session fixation')) {
    return AuthErrorCode.SESSION_FIXATION;
  }
  if (message.includes('challenge expired')) {
    return AuthErrorCode.CHALLENGE_EXPIRED;
  }
  if (message.includes('challenge') && message.includes('found')) {
    return AuthErrorCode.CHALLENGE_NOT_FOUND;
  }
  if (message.includes('refresh') && message.includes('revoked')) {
    return AuthErrorCode.REFRESH_REVOKED;
  }
  if (message.includes('refresh') && message.includes('invalid')) {
    return AuthErrorCode.REFRESH_INVALID;
  }
  if (message.includes('signature') || message.includes('invalid signature')) {
    return AuthErrorCode.INVALID_SIGNATURE;
  }
  if (message.includes('revoked') || message.includes('blacklist')) {
    return AuthErrorCode.REVOKED_TOKEN;
  }
  if (message.includes('expired') || message.includes('session')) {
    return AuthErrorCode.EXPIRED_SESSION;
  }
  if (message.includes('malformed') || message.includes('invalid token')) {
    return AuthErrorCode.MALFORMED_TOKEN;
  }
  if (message.includes('rate limit') || status === 429) {
    return AuthErrorCode.RATE_LIMITED;
  }

  if (status === 403) return AuthErrorCode.FORBIDDEN;
  return AuthErrorCode.UNAUTHORIZED;
}

/**
 * Authentication Exception Filter
 *
 * Catches all HTTP exceptions from auth-related endpoints and
 * transforms them into standardized error responses.
 *
 * Response format:
 * {
 *   statusCode: number,
 *   error: string,
 *   code: AuthErrorCode,
 *   message: string,
 *   timestamp: string,
 *   path: string
 * }
 */
@Catch(HttpException)
export class AuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AuthExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as any)?.message || exception.message;

    const errorCode = mapExceptionToErrorCode(exception);

    // Log security-relevant auth failures
    if (status >= 400 && status !== 404) {
      this.logger.warn(
        `Auth failure [${errorCode}] ${request.method} ${request.url} — ${JSON.stringify(
          typeof message === 'string' ? message : message,
        )}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      error: this.getErrorTitle(status),
      code: errorCode,
      message: Array.isArray(message) ? message[0] : message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private getErrorTitle(status: number): string {
    switch (status) {
      case 400:
        return 'Bad Request';
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 429:
        return 'Too Many Requests';
      default:
        return 'Authentication Error';
    }
  }
}
