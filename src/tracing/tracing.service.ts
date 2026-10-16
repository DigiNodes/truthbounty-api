import {
  context,
  propagation,
  ROOT_CONTEXT,
  Span,
  SpanContext,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { Injectable } from '@nestjs/common';

export type TraceCarrier = Record<string, string | string[] | undefined>;
export type DatabaseOperation =
  | 'find'
  | 'insert'
  | 'update'
  | 'delete'
  | 'transaction';

const SAFE_SPAN_NAMES = new Set([
  'operation',
  'http.server',
  'http.request',
  'database.query',
  'database.audit_log.insert',
  'indexer.poll',
  'indexer.event_batch',
  'indexer.process_event',
  'redis.get',
  'redis.set',
  'redis.del',
  'redis.ping',
  'job.process',
  'job.retry',
  'queue.publish',
  'queue.consume',
  'outbox.publish',
  'outbox.consume',
  'websocket.publish',
  'websocket.consume',
  'webhook.dispatch',
  'webhook.receive',
]);

const SAFE_ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'TimeoutError',
  'AbortError',
  'HttpException',
  'BadRequestException',
  'UnauthorizedException',
  'ForbiddenException',
  'NotFoundException',
  'ConflictException',
  'InternalServerErrorException',
]);

export interface TraceRequest {
  headers: TraceCarrier;
  method?: string;
}

export interface TraceResponse {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  once(event: 'finish' | 'close', listener: () => void): void;
}

@Injectable()
export class TracingService {
  private readonly tracer = trace.getTracer('truthbounty-api');

  async runSpan<T>(
    name: string,
    operation: (span: Span) => T | Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const safeName = SAFE_SPAN_NAMES.has(name) ? name : 'operation';
    const safeOptions = this.sanitizeSpanOptions(options);
    return this.tracer.startActiveSpan(safeName, safeOptions, async (span) => {
      try {
        return await operation(span);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('error.type', this.safeErrorType(error));
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async runRetrySpan<T>(
    name: string,
    previousAttempt: SpanContext,
    operation: (span: Span) => T | Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    const linkedParent = trace.setSpanContext(ROOT_CONTEXT, previousAttempt);
    return context.with(linkedParent, () =>
      this.runSpan(name, operation, {
        ...options,
        links: [...(options.links ?? []), { context: previousAttempt }],
      }),
    );
  }

  runProducerSpan<T>(
    name: string,
    operation: (carrier: TraceCarrier, span: Span) => T | Promise<T>,
    options: SpanOptions = {},
  ): Promise<T> {
    return this.runSpan(name, (span) => operation(this.inject({}), span), {
      ...options,
      kind: SpanKind.PRODUCER,
    });
  }

  runDatabaseSpan<T>(
    operation: DatabaseOperation,
    execute: () => T | Promise<T>,
    system: 'sqlite' | 'postgresql' = 'sqlite',
  ): Promise<T> {
    return this.runSpan('database.query', () => execute(), {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': system,
        'db.operation.name': operation,
      },
    });
  }

  runConsumerSpan<T>(
    name: string,
    carrier: TraceCarrier,
    operation: (span: Span) => T | Promise<T>,
    options: SpanOptions = {},
  ): T | Promise<T> {
    return this.runWithExtractedContext(carrier, () =>
      this.runSpan(name, operation, {
        ...options,
        kind: SpanKind.CONSUMER,
      }),
    );
  }

  runWithExtractedContext<T>(carrier: TraceCarrier, operation: () => T): T {
    const extracted = propagation.extract(ROOT_CONTEXT, carrier, {
      keys: (headers) => Object.keys(headers),
      get: (headers, key) => {
        const header = Object.entries(headers).find(
          ([name]) => name.toLowerCase() === key.toLowerCase(),
        )?.[1];
        return Array.isArray(header) ? undefined : header;
      },
    });
    return context.with(extracted, operation);
  }

  inject(carrier: TraceCarrier): TraceCarrier {
    for (const key of Object.keys(carrier)) {
      if (
        ['traceparent', 'tracestate', 'baggage'].includes(key.toLowerCase())
      ) {
        delete carrier[key];
      }
    }
    propagation.inject(context.active(), carrier, {
      set: (headers, key, value) => {
        headers[key] = value;
      },
    });
    return carrier;
  }

  getActiveSpanContext(): SpanContext | undefined {
    return trace.getSpan(context.active())?.spanContext();
  }

  getSupportReference(): string | undefined {
    return this.getActiveSpanContext()?.traceId;
  }

  createHttpMiddleware(): (
    request: TraceRequest,
    response: TraceResponse,
    next: () => void,
  ) => void {
    return (request, response, next) => {
      const extracted = propagation.extract(ROOT_CONTEXT, request.headers, {
        keys: (headers) => Object.keys(headers),
        get: (headers, key) => {
          const header = Object.entries(headers).find(
            ([name]) => name.toLowerCase() === key.toLowerCase(),
          )?.[1];
          return Array.isArray(header) ? undefined : header;
        },
      });
      const span = this.tracer.startSpan(
        'http.server',
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': this.safeMethod(request.method),
          },
        },
        extracted,
      );
      const active = trace.setSpan(extracted, span);
      const spanContext = span.spanContext();
      response.setHeader('traceparent', this.formatTraceParent(spanContext));
      response.setHeader('x-trace-id', spanContext.traceId);

      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        const statusCode = response.statusCode;
        if (typeof statusCode === 'number') {
          span.setAttribute('http.response.status_code', statusCode);
          if (statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
        }
        span.end();
      };

      response.once('finish', finish);
      response.once('close', finish);
      try {
        context.with(active, next);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('error.type', this.safeErrorType(error));
        finish();
        throw error;
      }
    };
  }

  private formatTraceParent(spanContext: SpanContext): string {
    const flags = spanContext.traceFlags.toString(16).padStart(2, '0');
    return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
  }

  private safeMethod(method?: string): string {
    return method && /^[A-Z]{1,16}$/.test(method) ? method : 'UNKNOWN';
  }

  private safeErrorType(error: unknown): string {
    if (!(error instanceof Error) || !SAFE_ERROR_TYPES.has(error.name)) {
      return 'Error';
    }
    return error.name;
  }

  private sanitizeSpanOptions(options: SpanOptions): SpanOptions {
    const allowedAttributes: Record<string, (value: unknown) => boolean> = {
      'db.system': (value) =>
        typeof value === 'string' &&
        ['redis', 'sqlite', 'postgresql'].includes(value),
      'db.operation.name': (value) =>
        typeof value === 'string' &&
        [
          'get',
          'set',
          'del',
          'ping',
          'insert',
          'find',
          'update',
          'delete',
          'transaction',
          'process_event',
        ].includes(value),
      'error.type': (value) =>
        typeof value === 'string' && SAFE_ERROR_TYPES.has(value),
      'http.request.method': (value) =>
        typeof value === 'string' && /^[A-Z]{1,16}$/.test(value),
      'http.response.status_code': (value) =>
        typeof value === 'number' && value >= 100 && value <= 599,
    };
    const attributes = Object.fromEntries(
      Object.entries(options.attributes ?? {}).filter(
        ([key, value]) => allowedAttributes[key]?.(value) === true,
      ),
    );
    const links = options.links?.map((link) => ({
      ...link,
      attributes: Object.fromEntries(
        Object.entries(link.attributes ?? {}).filter(
          ([key, value]) => allowedAttributes[key]?.(value) === true,
        ),
      ),
    }));

    return { ...options, attributes, links };
  }
}
