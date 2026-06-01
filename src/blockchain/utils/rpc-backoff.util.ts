/**
 * Intelligent retry/backoff for RPC calls.
 *
 * Public RPC providers throttle aggressively and answer with HTTP 429
 * ("Too Many Requests") or transient server/network errors. Failing the whole
 * indexing pass on the first 429 stalls the pipeline, so we retry with
 * exponential backoff and full jitter, only for errors that are actually
 * worth retrying.
 */

export interface RpcBackoffOptions {
  /** Maximum number of retries after the initial attempt. Default: 5. */
  maxRetries?: number;
  /** Base delay in ms for the first retry. Default: 250. */
  baseDelayMs?: number;
  /** Upper bound on any single delay in ms. Default: 10_000. */
  maxDelayMs?: number;
  /** Add randomised jitter to spread out retries. Default: true. */
  jitter?: boolean;
  /** Predicate deciding whether an error is worth retrying. */
  isRetryable?: (error: unknown) => boolean;
  /** Hook invoked before each backoff sleep (useful for logging/metrics). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleep, primarily so tests don't wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detect HTTP 429 / rate-limit responses across the shapes ethers, web3 and
 * raw fetch errors surface them in.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, any>;

  // Direct status fields used by various HTTP/JSON-RPC clients.
  if (err.status === 429 || err.statusCode === 429) {
    return true;
  }

  // ethers v6 nests the HTTP status under `info`.
  if (err.info?.responseStatus && String(err.info.responseStatus).includes('429')) {
    return true;
  }

  // JSON-RPC error codes: -32005 is the de-facto "limit exceeded" code.
  if (err.code === -32005) {
    return true;
  }

  const message = String(err.message ?? err.shortMessage ?? '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('rate-limit') ||
    message.includes('exceeded')
  );
}

/**
 * Default retryability: rate limits plus the transient ethers/network error
 * codes. Deterministic client errors (bad params, reverts) are not retried.
 */
export function isRetryableRpcError(error: unknown): boolean {
  if (isRateLimitError(error)) {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as Record<string, any>;
  const retryableCodes = new Set([
    'SERVER_ERROR',
    'TIMEOUT',
    'NETWORK_ERROR',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
  ]);

  if (retryableCodes.has(err.code)) {
    return true;
  }

  // 5xx gateway/server responses are transient.
  const status = Number(err.status ?? err.statusCode);
  return status >= 500 && status < 600;
}

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  // Exponential: base * 2^(attempt-1), capped at maxDelay.
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (!jitter) {
    return exponential;
  }
  // Full jitter: random point in [0, exponential].
  return Math.floor(Math.random() * exponential);
}

/**
 * Run `fn`, retrying transient failures (429s, server/network errors) with
 * exponential backoff. Re-throws the last error once retries are exhausted or
 * when the error is not retryable.
 */
export async function withRpcBackoff<T>(
  fn: () => Promise<T>,
  options: RpcBackoffOptions = {},
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelayMs = 250,
    maxDelayMs = 10_000,
    jitter = true,
    isRetryable = isRetryableRpcError,
    onRetry,
    sleep = defaultSleep,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Give up immediately on non-retryable errors or once retries run out.
      if (attempt === maxRetries || !isRetryable(error)) {
        throw error;
      }

      const delayMs = computeDelay(attempt + 1, baseDelayMs, maxDelayMs, jitter);
      onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  // Unreachable, but keeps the type checker happy.
  throw lastError;
}
