import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { ProfilerService } from './profiler.service';

@Injectable()
export class ProfilerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ProfilerInterceptor.name);

  constructor(private readonly profilerService: ProfilerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    // Evaluate sampling strategy
    const sampled = this.profilerService.shouldSample(request);
    if (!sampled) {
      return next.handle();
    }

    const routePath = request.route?.path || request.url || 'unknown';
    const method = request.method || 'GET';
    const traceName = `HTTP ${method} ${routePath}`;

    const trace = this.profilerService.startTrace(traceName, 'http', {
      route: routePath,
      method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      contentLength: request.headers['content-length']
        ? parseInt(request.headers['content-length'], 10)
        : 0,
    });

    return next.handle().pipe(
      tap(() => {
        const statusCode = response.statusCode || 200;
        this.profilerService.endTrace(trace.id, {
          route: routePath,
          method,
          statusCode,
          status: statusCode >= 400 ? 'error' : 'ok',
        });
      }),
      catchError((error) => {
        const statusCode = error.status || response.statusCode || 500;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.profilerService.endTrace(trace.id, {
          route: routePath,
          method,
          statusCode,
          status: 'error',
          errorMessage,
        });
        return throwError(() => error);
      }),
    );
  }
}
