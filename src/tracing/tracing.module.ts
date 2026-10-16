import { Module, Global, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { SafeBaggagePropagator } from './safe-baggage.propagator';
import { TracingService } from './tracing.service';

@Injectable()
export class TracingRuntime implements OnModuleDestroy {
  constructor(private readonly provider: BasicTracerProvider) {}

  async onModuleDestroy(): Promise<void> {
    await this.provider.forceFlush();
    await this.provider.shutdown();
  }
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: TracingRuntime,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const contextManager = new AsyncLocalStorageContextManager().enable();
        context.setGlobalContextManager(contextManager);
        propagation.setGlobalPropagator(
          new CompositePropagator({
            propagators: [
              new W3CTraceContextPropagator(),
              new SafeBaggagePropagator(),
            ],
          }),
        );

        const enabled =
          config.get<string>('TRACING_ENABLED', 'true') === 'true';
        const defaultRatio =
          config.get<string>('NODE_ENV') === 'production' ? 0.1 : 1;
        const configuredRatio = Number(
          config.get<string>('TRACING_SAMPLE_RATIO', String(defaultRatio)),
        );
        const ratio =
          Number.isFinite(configuredRatio) &&
          configuredRatio >= 0 &&
          configuredRatio <= 1
            ? configuredRatio
            : 0;
        const tracesEndpoint = config.get<string>(
          'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
        );
        const baseEndpoint = config
          .get<string>('OTEL_EXPORTER_OTLP_ENDPOINT')
          ?.replace(/\/+$/, '');
        const endpoint =
          tracesEndpoint ??
          (baseEndpoint
            ? baseEndpoint.endsWith('/v1/traces')
              ? baseEndpoint
              : `${baseEndpoint}/v1/traces`
            : undefined);
        const spanProcessors = endpoint
          ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))]
          : [];
        const provider = new BasicTracerProvider({
          sampler: enabled
            ? new ParentBasedSampler({
                root: new TraceIdRatioBasedSampler(ratio),
              })
            : new AlwaysOffSampler(),
          spanProcessors,
        });
        trace.setGlobalTracerProvider(provider);

        return new TracingRuntime(provider);
      },
    },
    {
      provide: TracingService,
      inject: [TracingRuntime],
      useFactory: () => new TracingService(),
    },
  ],
  exports: [TracingService],
})
export class TracingModule {}
