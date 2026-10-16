import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PinoLogger } from 'nestjs-pino';
import { TracingService } from '../tracing/tracing.service';

/**
 * Interceptor to log request/response timing and metadata
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly logger: PinoLogger,
    private readonly tracingService: TracingService,
  ) {
    this.logger.setContext('HTTP');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method?: string }>();
    const { method } = request;
    const startTime = Date.now();
    const traceId = this.tracingService.getSupportReference();

    // Log incoming request
    this.logger.info(
      {
        type: 'request',
        traceId,
        method,
      },
      'Incoming HTTP request',
    );

    return next.handle().pipe(
      tap({
        next: () => {
          const response = context
            .switchToHttp()
            .getResponse<{ statusCode: number }>();
          const duration = Date.now() - startTime;

          this.logger.info(
            {
              type: 'response',
              traceId,
              method,
              statusCode: response.statusCode,
              durationMs: duration,
            },
            `HTTP response ${response.statusCode} - ${duration}ms`,
          );
        },
        error: (error: unknown) => {
          const duration = Date.now() - startTime;
          const statusCode =
            error instanceof HttpException ? error.getStatus() : 500;

          this.logger.error(
            {
              type: 'error',
              traceId,
              method,
              durationMs: duration,
              statusCode,
            },
            `HTTP request failed - ${duration}ms`,
          );
        },
      }),
    );
  }
}
