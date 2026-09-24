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

export interface RpcProviderValidationOptions {
  expectedChainId?: number;
  expectedBlockHash?: string;
  blockHashField?: string;
}

export interface RpcProviderManagerOptions extends RpcBackoffOptions {
  chainId?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
  rateLimitMs?: number;
}

interface ProviderCircuitState {
  status: 'closed' | 'open';
  failures: number;
  openedAt: number;
  nextRetryAt: number;
  rateLimitUntil: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function normalizeChainId(value: unknown): number | null {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

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

export class RpcProviderManager {
  private readonly providerStates = new Map<string, ProviderCircuitState>();

  constructor(
    private readonly providers: Array<Record<string, any>>,
    private readonly options: RpcProviderManagerOptions = {},
  ) {
    this.providers.forEach((provider, index) => {
      const key = this.getProviderKey(provider, index);
      this.providerStates.set(key, {
        status: 'closed',
        failures: 0,
        openedAt: 0,
        nextRetryAt: 0,
        rateLimitUntil: 0,
      });
    });
  }

  getProviderState(providerKey: string): ProviderCircuitState | undefined {
    return this.providerStates.get(providerKey);
  }

  async call<T = any>(
    method: string,
    args: any[] = [],
    validation: RpcProviderValidationOptions = {},
  ): Promise<T> {
    const expectedChainId = validation.expectedChainId ?? this.options.chainId;
    let lastError: unknown;

    for (let index = 0; index < this.providers.length; index++) {
      const provider = this.providers[index];
      const providerKey = this.getProviderKey(provider, index);
      const state = this.providerStates.get(providerKey) ?? this.createState(providerKey);

      if (state.status === 'open' && Date.now() < state.nextRetryAt) {
        continue;
      }

      if (state.status === 'open' && Date.now() >= state.nextRetryAt) {
        state.status = 'closed';
        state.failures = 0;
      }

      if (state.rateLimitUntil > Date.now()) {
        continue;
      }

      try {
        const network = await provider.getNetwork?.();
        const observedChainId = normalizeChainId(network?.chainId);
        if (
          expectedChainId !== undefined &&
          observedChainId !== null &&
          observedChainId !== expectedChainId
        ) {
          throw new Error(
            `RPC chain mismatch on ${providerKey}: expected ${expectedChainId}, got ${observedChainId}`,
          );
        }

        const result = await withRpcBackoff(
          () => provider[method](...args),
          {
            maxRetries: this.options.maxRetries ?? 5,
            baseDelayMs: this.options.baseDelayMs ?? 250,
            maxDelayMs: this.options.maxDelayMs ?? 10_000,
            jitter: this.options.jitter ?? true,
            isRetryable: this.options.isRetryable ?? isRetryableRpcError,
            onRetry: (error, attempt, delayMs) => {
              if (this.options.onRetry) {
                this.options.onRetry(error, attempt, delayMs);
              }
            },
            sleep: this.options.sleep ?? defaultSleep,
          },
        );

        if (
          validation.expectedBlockHash &&
          result && typeof result === 'object' &&
          'hash' in result
        ) {
          const actualHash = String((result as Record<string, any>).hash ?? '').toLowerCase();
          const expectedHash = validation.expectedBlockHash.toLowerCase();
          if (actualHash && actualHash !== expectedHash) {
            throw new Error(
              `RPC block hash mismatch for ${providerKey}: expected ${expectedHash}, got ${actualHash}`,
            );
          }
        }

        this.markSuccess(providerKey);
        return result as T;
      } catch (error) {
        lastError = error;
        this.markFailure(providerKey, error);
      }
    }

    throw lastError ?? new Error(`All RPC providers failed for method ${method}`);
  }

  private createState(providerKey: string): ProviderCircuitState {
    const state = {
      status: 'closed' as const,
      failures: 0,
      openedAt: 0,
      nextRetryAt: 0,
      rateLimitUntil: 0,
    };
    this.providerStates.set(providerKey, state);
    return state;
  }

  private getProviderKey(provider: Record<string, any>, index: number): string {
    if (provider?.name) {
      return String(provider.name);
    }
    if (provider?.url) {
      return String(provider.url);
    }
    if (index === 0) {
      return 'primary';
    }
    if (index === 1) {
      return 'secondary';
    }
    return `provider-${index}`;
  }

  private markSuccess(providerKey: string): void {
    const state = this.providerStates.get(providerKey);
    if (!state) {
      return;
    }
    state.failures = 0;
    state.status = 'closed';
    state.openedAt = 0;
    state.nextRetryAt = 0;
    state.rateLimitUntil = 0;
  }

  private markFailure(providerKey: string, error: unknown): void {
    const state = this.providerStates.get(providerKey);
    if (!state) {
      return;
    }

    const threshold = this.options.circuitBreakerThreshold ?? 3;
    const resetMs = this.options.circuitBreakerResetMs ?? 60_000;
    const rateLimitDelayMs = this.options.rateLimitMs ?? 1_000;

    if (isRateLimitError(error)) {
      state.rateLimitUntil = Date.now() + rateLimitDelayMs;
      state.failures += 1;
    } else {
      state.failures += 1;
    }

    if (state.failures >= threshold) {
      state.status = 'open';
      state.openedAt = Date.now();
      state.nextRetryAt = state.openedAt + resetMs;
    }
  }
}

export async function withRpcFailover<T>(
  providers: Array<Record<string, any>>,
  fn: (provider: Record<string, any>) => Promise<T>,
  options: RpcProviderManagerOptions = {},
): Promise<T> {
  const manager = new RpcProviderManager(providers, options);

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    try {
      return await manager.call<T>(
        'call',
        [provider, fn],
        { expectedChainId: options.chainId },
      );
    } catch {
      // continue to the next provider in the ordered list
    }
  }

  throw new Error('All configured RPC providers failed');
}
