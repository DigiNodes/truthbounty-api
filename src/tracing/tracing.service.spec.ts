import { context, propagation, SpanContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import {
  BasicTracerProvider,
  AlwaysOffSampler,
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SafeBaggagePropagator } from './safe-baggage.propagator';
import { TracingService } from './tracing.service';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  sampler: new ParentBasedSampler({
    root: new AlwaysOnSampler(),
    remoteParentSampled: new AlwaysOnSampler(),
    remoteParentNotSampled: new AlwaysOffSampler(),
  }),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(
  new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new SafeBaggagePropagator()],
  }),
);
trace.setGlobalTracerProvider(provider);

const service = new TracingService();

const sampledParent = (
  traceId: string,
  spanId = '1111111111111111',
  flags = '01',
) => `00-${traceId}-${spanId}-${flags}`;

describe('TracingService', () => {
  beforeEach(() => exporter.reset());

  it('propagates parent context to child spans', async () => {
    const traceId = '00000000000000000000000000000001';
    await service.runWithExtractedContext(
      { traceparent: sampledParent(traceId) },
      () =>
        service.runSpan('http.request', async (parent) => {
          await service.runSpan('database.query', (child) => {
            expect(child.spanContext().traceId).toBe(traceId);
            expect(child.spanContext().traceId).toBe(
              parent.spanContext().traceId,
            );
          });
        }),
    );

    const spans = exporter.getFinishedSpans();
    const child = spans.find((span) => span.name === 'database.query');
    const parent = spans.find((span) => span.name === 'http.request');
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it('starts a new root for broken trace context without throwing', async () => {
    let rootContext: SpanContext | undefined;
    await service.runWithExtractedContext(
      { traceparent: 'broken', baggage: 'user.email=private@example.test' },
      () =>
        service.runSpan('http.request', (span) => {
          rootContext = span.spanContext();
        }),
    );

    const span = exporter.getFinishedSpans()[0];
    expect(rootContext?.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('links retries to the original attempt instead of creating another trace root', async () => {
    let firstAttempt: SpanContext | undefined;
    await service.runSpan('job.process', (span) => {
      firstAttempt = span.spanContext();
    });

    await service.runRetrySpan('job.retry', firstAttempt!, () => undefined);

    const spans = exporter.getFinishedSpans();
    const original = spans.find((span) => span.name === 'job.process');
    const retry = spans.find((span) => span.name === 'job.retry');
    expect(retry?.spanContext().traceId).toBe(original?.spanContext().traceId);
    expect(retry?.parentSpanContext?.spanId).toBe(
      original?.spanContext().spanId,
    );
    expect(retry?.links[0].context.spanId).toBe(original?.spanContext().spanId);
  });

  it('fans out distinct child contexts and propagates each through carriers', async () => {
    const traceId = '00000000000000000000000000000002';
    const carriers: Record<string, string | string[] | undefined>[] = [];
    await service.runWithExtractedContext(
      { traceparent: sampledParent(traceId) },
      () =>
        service.runSpan('http.request', async () => {
          for (const destination of ['queue', 'webhook']) {
            const operationName =
              destination === 'queue' ? 'queue.publish' : 'webhook.dispatch';
            await service.runProducerSpan(operationName, (carrier) => {
              carriers.push(carrier);
            });
          }
        }),
    );

    const [queue, webhook] = carriers;
    expect(queue.traceparent).not.toBe(webhook.traceparent);
    for (const carrier of carriers) {
      expect(carrier.traceparent).toContain(traceId);
      expect(carrier.traceparent).toMatch(/-01$/);
    }

    let consumerTraceId: string | undefined;
    await service.runConsumerSpan('queue.consume', carriers[0], (span) => {
      consumerTraceId = span.spanContext().traceId;
    });
    expect(consumerTraceId).toBe(traceId);
  });

  it('starts an HTTP server span and returns only a safe trace reference', () => {
    const traceId = '00000000000000000000000000000007';
    const headers: Record<string, string> = {};
    const listeners = new Map<string, () => void>();
    const response = {
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    };
    let activeTraceId: string | undefined;
    const middleware = service.createHttpMiddleware();

    middleware(
      {
        method: 'GET',
        headers: {
          traceparent: sampledParent(traceId),
          authorization: 'Bearer do-not-propagate',
          baggage: 'user.email=private@example.test',
        },
      },
      response,
      () => {
        activeTraceId = service.getActiveSpanContext()?.traceId;
      },
    );
    listeners.get('finish')?.();

    expect(activeTraceId).toBe(traceId);
    expect(headers['x-trace-id']).toBe(traceId);
    expect(headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(JSON.stringify(headers)).not.toMatch(
      /do-not-propagate|private@example/i,
    );
  });

  it('creates database child spans with fixed operation metadata only', async () => {
    await service.runWithExtractedContext(
      { traceparent: sampledParent('0000000000000000000000000000000a') },
      () =>
        service.runSpan('http.request', () =>
          service.runDatabaseSpan('update', () => 'updated', 'postgresql'),
        ),
    );

    const databaseSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === 'database.query');
    expect(databaseSpan?.attributes).toEqual({
      'db.system': 'postgresql',
      'db.operation.name': 'update',
    });
  });

  it('applies deterministic sampling to sampled and unsampled remote contexts', async () => {
    await service.runWithExtractedContext(
      { traceparent: sampledParent('00000000000000000000000000000003') },
      () => service.runSpan('http.request', () => undefined),
    );
    await service.runWithExtractedContext(
      {
        traceparent: sampledParent(
          'ffffffff000000000000000000000000',
          '1111111111111111',
          '00',
        ),
      },
      () => service.runSpan('http.request', () => undefined),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('http.request');
  });

  it('filters baggage to bounded safe values and excludes malicious headers', async () => {
    let injected: Record<string, string | string[] | undefined> = {};
    await service.runWithExtractedContext(
      {
        traceparent: sampledParent('00000000000000000000000000000004'),
        baggage:
          'operation.type=queue,service.name=truthbounty-api,user.email=private@example.test,authorization=Bearer-secret',
      },
      () =>
        service.runSpan('request', () => {
          injected = service.inject({});
        }),
    );

    expect(injected.baggage).toBe(
      'operation.type=queue,service.name=truthbounty-api',
    );
    expect(JSON.stringify(injected)).not.toMatch(
      /private|Bearer-secret|authorization/i,
    );

    let oversized: Record<string, string | string[] | undefined> = {};
    await service.runWithExtractedContext(
      {
        traceparent: sampledParent('00000000000000000000000000000005'),
        baggage: `operation.type=queue,user.data=${'a'.repeat(600)}`,
      },
      () =>
        service.runSpan('request', () => {
          oversized = service.inject({});
        }),
    );
    expect(oversized.baggage).toBeUndefined();

    let filtered: Record<string, string | string[] | undefined> = {};
    await service.runWithExtractedContext(
      {
        traceparent: sampledParent('00000000000000000000000000000008'),
        baggage:
          'user.id=private,user.email=private@example.test,token=secret,session.id=secret,operation.type=webhook',
      },
      () =>
        service.runSpan('http.request', () => {
          filtered = service.inject({});
        }),
    );
    expect(filtered.baggage).toBe('operation.type=webhook');
  });

  it('does not record raw URLs, headers, or exception messages in spans', async () => {
    await expect(
      service.runWithExtractedContext(
        { traceparent: sampledParent('00000000000000000000000000000006') },
        () =>
          service.runSpan('http.server', () => {
            throw new Error('secret-token-value');
          }),
      ),
    ).rejects.toThrow('secret-token-value');

    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes).not.toHaveProperty('http.url');
    expect(span.attributes).not.toHaveProperty(
      'http.request.header.authorization',
    );
    expect(span.attributes).not.toHaveProperty('exception.message');
    expect(span.attributes['error.type']).toBe('Error');
  });

  it('drops unapproved span attributes and unsafe operation names', async () => {
    await service.runSpan('user.secret@example.test', () => undefined, {
      attributes: {
        'user.email': 'private@example.test',
        'db.operation.name': 'select private_data',
      },
    });

    const span = exporter.getFinishedSpans()[0];
    expect(span.name).toBe('operation');
    expect(span.attributes).toEqual({});
  });

  it('normalizes attacker-controlled exception names before recording them', async () => {
    await service
      .runWithExtractedContext(
        { traceparent: sampledParent('00000000000000000000000000000009') },
        () =>
          service.runSpan('http.request', () => {
            const error = new Error('authorization=secret');
            error.name = 'private.user@example.test';
            throw error;
          }),
      )
      .catch(() => undefined);

    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes['error.type']).toBe('Error');
    expect(JSON.stringify(span.attributes)).not.toMatch(
      /private\.user|secret/i,
    );
  });
});
