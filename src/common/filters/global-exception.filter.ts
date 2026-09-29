import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PublicErrorCode, ERROR_CODE_DESCRIPTIONS } from '../constants/error-codes';
import { redactObject, generateRequestId } from '../utils/redaction.util';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = generateRequestId();
    const timestamp = new Date().toISOString();

    let status: number;
    let publicCode: PublicErrorCode;
    let message: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responsePayload = exception.getResponse();
      message =
        typeof responsePayload === 'string'
          ? responsePayload
          : (responsePayload as any).message || exception.message;

      // Map HTTP status to public error codes
      publicCode = this.mapStatusToErrorCode(status);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      publicCode = PublicErrorCode.INTERNAL_SERVER_ERROR;
      message = ERROR_CODE_DESCRIPTIONS[PublicErrorCode.INTERNAL_SERVER_ERROR];

      // Log the full exception for internal debugging
      this.logger.error(
        `Unhandled exception: ${JSON.stringify(redactObject(exception))}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // Redact any sensitive data in the response payload
    const redactedMessage = redactObject(message);

    // Construct the public response
    const publicResponse = {
      statusCode: status,
      errorCode: publicCode,
      message: redactedMessage,
      timestamp,
      requestId,
      path: request.url,
    };

    response.status(status).json(publicResponse);
  }

  private mapStatusToErrorCode(status: number): PublicErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return PublicErrorCode.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return PublicErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return PublicErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return PublicErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return PublicErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return PublicErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return PublicErrorCode.SERVICE_UNAVAILABLE;
      default:
        return PublicErrorCode.INTERNAL_SERVER_ERROR;
    }
  }
}