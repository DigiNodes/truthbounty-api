/**
 * Retry Utilities - hardened retry mechanism with exponential backoff, jitter, and error classification
 * 
 * Security invariants:
 * - No PII, secrets, or settlement data in retry metadata
 * - Idempotency preservation through deterministic keys
 * - Fail-closed behavior for unknown errors
 */

/**
 * Error classification for retry behavior
 */
export enum ErrorClassification {
  /** Transient network/connectivity issues - safe to retry */
  NETWORK = 'NETWORK',
  /** Temporary resource constraints - safe to retry with backoff */
  RESOURCE = 'RESOURCE',
  /** Rate limiting - safe to retry with exponential backoff */
  RATE_LIMIT = 'RATE_LIMIT',
  /** Database deadlocks/lock contention - safe to retry */
  DEADLOCK = 'DEADLOCK',
  /** Invalid data/format - non-retryable, dead-letter immediately */
  VALIDATION = 'VALIDATION',
  /** Authorization failures - non-retryable, dead-letter immediately */
  AUTHORIZATION = 'AUTHORIZATION',
  /** Not found errors - non-retryable, dead-letter immediately */
  NOT_FOUND = 'NOT_FOUND',
  /** Unknown/unclassified errors - fail-closed, dead-letter immediately */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Retry policy configuration for specific error classifications
 */
export interface ClassificationRetryPolicy {
  /** Maximum retry attempts for this classification */
  maxAttempts: number;
  /** Initial backoff delay in milliseconds */
  initialDelayMs: number;
  /** Backoff multiplier for exponential increase */
  backoffMultiplier: number;
  /** Maximum backoff delay cap in milliseconds */
  maxDelayMs: number;
  /** Whether to add jitter to prevent thundering herd */
  jitterEnabled: boolean;
  /** Jitter percentage (0-1) */
  jitterRatio: number;
}

/**
 * Retry result metadata
 */
export interface RetryResult {
  /** Whether the operation should be retried */
  shouldRetry: boolean;
  /** Next delay in milliseconds (if retrying) */
  nextDelayMs: number;
  /** Current attempt count */
  attempt: number;
  /** Error classification */
  classification: ErrorClassification;
  /** Recommended action */
  action: 'retry' | 'dead_letter' | 'abort';
}

/**
 * Error pattern for classification matching
 */
export interface ErrorPattern {
  /** Error classification */
  classification: ErrorClassification;
  /** Error message patterns (regex) to match */
  patterns: RegExp[];
  /** Custom policy override (optional) */
  policyOverride?: Partial<ClassificationRetryPolicy>;
}

/**
 * Default retry policies by error classification
 */
export const DEFAULT_RETRY_POLICIES: Record<ErrorClassification, ClassificationRetryPolicy> = {
  [ErrorClassification.NETWORK]: {
    maxAttempts: 5,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 30000,
    jitterEnabled: true,
    jitterRatio: 0.3,
  },
  [ErrorClassification.RESOURCE]: {
    maxAttempts: 3,
    initialDelayMs: 2000,
    backoffMultiplier: 2,
    maxDelayMs: 10000,
    jitterEnabled: true,
    jitterRatio: 0.2,
  },
  [ErrorClassification.RATE_LIMIT]: {
    maxAttempts: 5,
    initialDelayMs: 5000,
    backoffMultiplier: 3,
    maxDelayMs: 60000,
    jitterEnabled: true,
    jitterRatio: 0.5,
  },
  [ErrorClassification.DEADLOCK]: {
    maxAttempts: 3,
    initialDelayMs: 100,
    backoffMultiplier: 4,
    maxDelayMs: 5000,
    jitterEnabled: true,
    jitterRatio: 0.4,
  },
  [ErrorClassification.VALIDATION]: {
    maxAttempts: 0, // No retries for validation errors
    initialDelayMs: 0,
    backoffMultiplier: 1,
    maxDelayMs: 0,
    jitterEnabled: false,
    jitterRatio: 0,
  },
  [ErrorClassification.AUTHORIZATION]: {
    maxAttempts: 0, // No retries for auth errors
    initialDelayMs: 0,
    backoffMultiplier: 1,
    maxDelayMs: 0,
    jitterEnabled: false,
    jitterRatio: 0,
  },
  [ErrorClassification.NOT_FOUND]: {
    maxAttempts: 0, // No retries for not found errors
    initialDelayMs: 0,
    backoffMultiplier: 1,
    maxDelayMs: 0,
    jitterEnabled: false,
    jitterRatio: 0,
  },
  [ErrorClassification.UNKNOWN]: {
    maxAttempts: 0, // Fail-closed for unknown errors
    initialDelayMs: 0,
    backoffMultiplier: 1,
    maxDelayMs: 0,
    jitterEnabled: false,
    jitterRatio: 0,
  },
};

/**
 * Default error patterns for classification
 */
export const DEFAULT_ERROR_PATTERNS: ErrorPattern[] = [
  {
    classification: ErrorClassification.NETWORK,
    patterns: [
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /ENOTFOUND/i,
      /ECONNRESET/i,
      /EPIPE/i,
      /network/i,
      /connection/i,
      /timeout/i,
    ],
  },
  {
    classification: ErrorClassification.RESOURCE,
    patterns: [
      /out of memory/i,
      /disk space/i,
      /resource temporarily unavailable/i,
      /too many open files/i,
    ],
  },
  {
    classification: ErrorClassification.RATE_LIMIT,
    patterns: [
      /rate limit/i,
      /429/i,
      /too many requests/i,
      /quota exceeded/i,
    ],
  },
  {
    classification: ErrorClassification.DEADLOCK,
    patterns: [
      /deadlock/i,
      /lock contention/i,
      /serialization failure/i,
      /could not serialize/i,
    ],
  },
  {
    classification: ErrorClassification.VALIDATION,
    patterns: [
      /validation/i,
      /invalid.*format/i,
      /malformed/i,
      /schema/i,
      /parse error/i,
    ],
  },
  {
    classification: ErrorClassification.AUTHORIZATION,
    patterns: [
      /unauthorized/i,
      /forbidden/i,
      /401/i,
      /403/i,
      /permission denied/i,
    ],
  },
  {
    classification: ErrorClassification.NOT_FOUND,
    patterns: [
      /not found/i,
      /404/i,
      /does not exist/i,
      /no such/i,
    ],
  },
];

/**
 * Classify an error based on message patterns
 */
export function classifyError(error: Error | string): ErrorClassification {
  const errorMessage = typeof error === 'string' ? error : error.message;
  
  for (const pattern of DEFAULT_ERROR_PATTERNS) {
    for (const regex of pattern.patterns) {
      if (regex.test(errorMessage)) {
        return pattern.classification;
      }
    }
  }
  
  // Fail-closed for unknown errors
  return ErrorClassification.UNKNOWN;
}

/**
 * Calculate exponential backoff with jitter
 */
export function calculateBackoffWithJitter(
  attempt: number,
  policy: ClassificationRetryPolicy,
): number {
  if (!policy.jitterEnabled) {
    return Math.min(
      policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt),
      policy.maxDelayMs,
    );
  }
  
  const baseDelay = Math.min(
    policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt),
    policy.maxDelayMs,
  );
  
  // Add jitter: delay = baseDelay * (1 - jitterRatio/2) + random * baseDelay * jitterRatio
  const jitterRange = baseDelay * policy.jitterRatio;
  const randomJitter = Math.random() * jitterRange;
  const minDelay = baseDelay - jitterRange / 2;
  
  return Math.max(minDelay + randomJitter, 0);
}

/**
 * Determine retry behavior based on error and attempt count
 */
export function determineRetryBehavior(
  error: Error | string,
  currentAttempt: number,
  customPolicy?: Partial<ClassificationRetryPolicy>,
): RetryResult {
  const classification = classifyError(error);
  const basePolicy = DEFAULT_RETRY_POLICIES[classification];
  const policy = { ...basePolicy, ...customPolicy };
  
  if (policy.maxAttempts === 0 || currentAttempt >= policy.maxAttempts) {
    return {
      shouldRetry: false,
      nextDelayMs: 0,
      attempt: currentAttempt,
      classification,
      action: 'dead_letter',
    };
  }
  
  const nextDelayMs = calculateBackoffWithJitter(currentAttempt, policy);
  
  return {
    shouldRetry: true,
    nextDelayMs,
    attempt: currentAttempt + 1,
    classification,
    action: 'retry',
  };
}

/**
 * Get retry policy for a specific classification
 */
export function getRetryPolicy(
  classification: ErrorClassification,
  customOverride?: Partial<ClassificationRetryPolicy>,
): ClassificationRetryPolicy {
  const basePolicy = DEFAULT_RETRY_POLICIES[classification];
  return { ...basePolicy, ...customOverride };
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: Error | string): boolean {
  const classification = classifyError(error);
  return DEFAULT_RETRY_POLICIES[classification].maxAttempts > 0;
}

/**
 * Format retry metadata for logging (redacted)
 */
export function formatRetryMetadata(result: RetryResult): string {
  return JSON.stringify({
    classification: result.classification,
    action: result.action,
    attempt: result.attempt,
    nextDelayMs: result.nextDelayMs,
  });
}
