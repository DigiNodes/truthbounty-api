# Trace Propagation

The tracing module uses W3C Trace Context and a strict baggage allowlist. HTTP
requests inherit valid `traceparent`/`tracestate` values; malformed context
starts a new trace. Responses expose the generated trace ID as `x-trace-id`, a
random, non-user-derived support reference.

Configuration:

- `TRACING_ENABLED` controls recording; propagation remains enabled when false.
- `TRACING_SAMPLE_RATIO` must be between `0` and `1`. The default is `0.1` in
  production and `1` otherwise. Invalid values fail closed to `0`.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` sets the exact OTLP traces endpoint.
- `OTEL_EXPORTER_OTLP_ENDPOINT` sets the base endpoint; `/v1/traces` is appended
  when absent. Without either endpoint, spans are not exported.

Only these baggage key/value pairs are propagated: fixed deployment
environment, fixed service name, and fixed operation type. Header baggage is
limited to 512 bytes and four entries. Span names and attributes are also
allowlisted; arbitrary values, URLs, request data, cache keys, and exception
messages are not recorded.

Wrap database repository calls with `runDatabaseSpan` and one of its fixed
operations (`find`, `insert`, `update`, `delete`, or `transaction`).

Use `runProducerSpan` to create a producer span and pass its returned carrier to
a queue, outbox, webhook, or WebSocket transport. Use `runConsumerSpan` when
processing that carrier. Use `runRetrySpan` with the prior attempt's
`SpanContext`; retries remain linked to that trace instead of creating unrelated
roots.
