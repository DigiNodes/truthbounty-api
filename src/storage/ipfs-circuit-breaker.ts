export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

/**
 * Per-provider circuit breaker. One instance per provider so a failing
 * provider is isolated without affecting the others.
 */
export class ProviderCircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.failures < this.options.failureThreshold) return 'closed';
    if (this.now() - this.openedAt >= this.options.cooldownMs) {
      return 'half_open';
    }
    return 'open';
  }

  /** Returns true if a request may be sent. Half-open admits one probe. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probing = false;
  }

  recordFailure(): void {
    this.probing = false;
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.openedAt = this.now();
    }
  }
}
