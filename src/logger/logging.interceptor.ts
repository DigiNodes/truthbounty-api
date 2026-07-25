import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PinoLogger } from 'nestjs-pino';
import { maskIp } from '../audit/utils/ip-masking';

/**
 * Interceptor to log request/response timing and metadata
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('HTTP');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const { method, url, body, query, params } = request;
    const startTime = Date.now();
    const requestId = request.id || crypto.randomUUID();

    // Log incoming request
    this.logger.info(
      {
        type: 'request',
        requestId,
        method,
        url,
        query: Object.keys(query || {}).length ? query : undefined,
        params: Object.keys(params || {}).length ? params : undefined,
        hasBody: !!body && Object.keys(body).length > 0,
        userAgent: request.headers['user-agent'],
        ip: maskIp(request.ip),
      },
      `Incoming ${method} ${url}`,
    );

    return next.handle().pipe(
      tap({
        next: () => {
          const response = context.switchToHttp().getResponse();
          const duration = Date.now() - startTime;

          this.logger.info(
            {
              type: 'response',
              requestId,
              method,
              url,
              statusCode: response.statusCode,
              durationMs: duration,
            },
            `${method} ${url} ${response.statusCode} - ${duration}ms`,
          );
        },
        error: (error) => {
          const duration = Date.now() - startTime;

          this.logger.error(
            {
              type: 'error',
              requestId,
              method,
              url,
              durationMs: duration,
              errorType: error.constructor?.name,
              errorMessage: error.message,
              statusCode: error.status || 500,
            },
            `${method} ${url} ERROR - ${duration}ms`,
          );
        },
      }),
    );
  }
}
