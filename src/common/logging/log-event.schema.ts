import { CorrelationContext } from './correlation.context';

/**
 * Typed log event schema.
 *
 * All production logs must be constructed as a `LogEvent` and passed through the
 * centralized redaction boundary before being emitted. The schema defines the
 * approved fields and the allowed log levels. Unknown fields are dropped by the
 * logger so user-controlled keys cannot forge log records.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEventInput {
  level: LogLevel;
  event: string;
  message: string;
  component?: string;
  correlationId?: string;
  traceId?: string;
  requestId?: string;
  jobId?: string;
  userId?: string;
  wallet?: string;
  durationMs?: number;
  status?: string;
  error?: unknown;
  data?: Record<string, unknown>;
  timestamp?: string;
}

export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  component?: string;
  correlationId?: string;
  traceId?: string;
  requestId?: string;
  jobId?: string;
  userId?: string;
  wallet?: string;
  durationMs?: number;
  status?: string;
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
  };
  data?: Record<string, unknown>;
}

/**
 * The canonical set of fields allowed on a log event. Any field not listed
 * here is dropped during normalization.
 */
export const APPROVED_LOG_FIELDS: Readonly<string[]> = [
  'timestamp',
  'level',
  'event',
  'message',
  'component',
  'correlationId',
  'traceId',
  'requestId',
  'jobId',
  'userId',
  'wallet',
  'durationMs',
  'status',
  'error',
  'data',
];

export const MAX_STRING_LENGTH = 2000;
export const MAX_DEPTH = 6;
export const MAX_ARRAY = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Error)
  );
}

function sanitizeString(value: string): string {
  // Remove control characters that could forge log records or inject newlines.
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (stripped.length > MAX_STRING_LENGTH) {
    return `${stripped.slice(0, MAX_STRING_LENGTH)}[kruncated]`;
  }
  return stripped;
}

function normalizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    };
  }
  if (depth > MAX_DEPTH) {
    return '[max-depth]';
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return '[circular]';
    }
    seen.add(value as object);
    if (Array.isArray(value)) {
      const limited = value.slice(0, MAX_ARRAY).map((item) =>
        normalizeValue(item, depth + 1, seen),
      );
      if (value.length > MAX_ARRAY) {
        limited.push(`[+truncated ${value.length - MAX_ARRAY} items]`);
      }
      return limited;
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        out[sanitizeString(key)] = normalizeValue(inner, depth + 1, seen);
      }
      return out;
    }
    return String(value);
  }
  return String(value);
}

export function normalizeError(error: unknown): LogEvent['error'] | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: sanitizeString(error.message),
      code: code !== undefined ? sanitizeString(String(code)) : undefined,
      stack: error.stack ? sanitizeString(error.stack) : undefined,
    };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: sanitizeString(error) };
  }
  return { name: 'Error', message: sanitizeString(String(error)) };
}

/**
 * Normalize an input into a canonical `LogEvent`. Only approved fields are
 * kept, and all values are sanitized. Correlation context is merged in when
 * not explicitly provided.
 */
export function normalizeLogEvent(
  input: LogEventInput,
  context?: CorrelationContext,
): LogEvent {
  const seen = new WeakSet<object>();
  const event: LogEvent = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    level: input.level,
    event: sanitizeString(input.event),
    message: sanitizeString(input.message),
  };

  if (input.component) {
    event.component = sanitizeString(input.component);
  }
  event.correlationId = input.correlationId ?? context?.correlationId;
  event.traceId = input.traceId ?? context?.traceId;
  event.requestId = input.requestId ?? context?.requestId;
  event.jobId = input.jobId ?? context?.jobId;
  if (input.userId) {
    event.userId = sanitizeString(input.userId);
  }
  if (input.wallet) {
    event.wallet = sanitizeString(input.wallet);
  }
  if (typeof input.durationMs === 'number') {
    event.durationMs = input.durationMs;
  }
  if (input.status) {
    event.status = sanitizeString(input.status);
  }
  if (input.error !== undefined) {
    event.error = normalizeError(input.error);
  }
  if (input.data) {
    event.data = normalizeValue(input.data, 0, seen) as Record<
      string,
      unknown
    >;
  }
  return event;
}
