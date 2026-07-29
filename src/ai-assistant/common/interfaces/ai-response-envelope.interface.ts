export interface AiResponseEnvelopeError {
  code: string;
  message: string;
  details?: unknown;
}

export interface AiResponseEnvelopeMeta {
  cached?: boolean;
  latencyMs?: number;
  fallback?: boolean;
  [key: string]: unknown;
}

export interface AiResponseEnvelope<T = unknown> {
  success: boolean;
  requestId: string;
  timestamp: string;
  data: T | null;
  error: AiResponseEnvelopeError | null;
  meta?: AiResponseEnvelopeMeta;
}
