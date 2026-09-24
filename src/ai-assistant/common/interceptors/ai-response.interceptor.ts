import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import {
  AiResponseEnvelope,
  AiResponseEnvelopeMeta,
} from '../interfaces/ai-response-envelope.interface';

interface WithMeta {
  data: unknown;
  meta: AiResponseEnvelopeMeta;
}

function hasMeta(value: unknown): value is WithMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'meta' in value &&
    Object.keys(value).length === 2
  );
}

/**
 * Wraps successful AI-assistant controller responses in a standardised
 * envelope. Applied per-controller (not globally — no such convention exists
 * elsewhere in this repo yet). Pair with AiExceptionFilter, which produces
 * the same envelope shape on the error path.
 *
 * Controller handlers may return either the raw payload, or
 * `{ data, meta }` when they need to attach envelope metadata (e.g.
 * `meta.cached`, `meta.fallback`).
 */
@Injectable()
export class AiResponseInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<AiResponseEnvelope> {
    const request = context.switchToHttp().getRequest();
    const requestId: string = request.id || crypto.randomUUID();

    return next.handle().pipe(
      map((result) => {
        const { data, meta } = hasMeta(result)
          ? result
          : { data: result, meta: undefined };
        return {
          success: true,
          requestId,
          timestamp: new Date().toISOString(),
          data: data ?? null,
          error: null,
          ...(meta ? { meta } : {}),
        };
      }),
    );
  }
}
