import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation context propagated across async boundaries (HTTP requests,
 * workers, streams, and jobs) via AsyncLocalStorage.
 */
export interface CorrelationContext {
  correlationId?: string;
  traceId?: string;
  requestId?: string;
  jobId?: string;
}

export const CORRELATION_HEADER = 'x-correlation-id';
export const TRACE_HEADER = 'x-trace-id';
export const REQUEST_HEADER = 'x-request-id';

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationContext(): CorrelationContext {
  return correlationStorage.getStore() ?? {};
}

export function runWithCorrelationContext<T>(
  context: CorrelationContext,
  callback: () => T,
): T {
  const merged = { ...getCorrelationContext(), ...context };
  return correlationStorage.run(merged, callback);
}

export function setCorrelationContext(context: CorrelationContext): void {
  const merged = { ...getCorrelationContext(), ...context };
  correlationStorage.enterWith(merged);
}

export function clearCorrelationContext(): void {
  correlationStorage.enterWith({});
}

export function generateCorrelationId(): string {
  return globalThis.crypto?.randomUUID() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
