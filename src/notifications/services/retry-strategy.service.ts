import { Injectable, Logger } from '@nestjs/common';
import { EventType, PRIORITY_RETRY_CONFIG } from '../enums/event-type.enum';

export enum ErrorClassification {
  NETWORK = 'NETWORK',
  RATE_LIMIT = 'RATE_LIMIT',
  FATAL = 'FATAL',
  TRANSIENT = 'TRANSIENT',
}

export interface RetryDecision {
  shouldRetry: boolean;
  classification: ErrorClassification;
  nextDelayMs: number;
  reason: string;
}

/**
 * RetryStrategy
 * 
 * Implements retry logic with exponential backoff.
 * 
 * Error Classification:
 * - NETWORK: Temporary network issues (timeout, connection refused) → retry
 * - RATE_LIMIT: 429 Too Many Requests → retry with longer backoff
 * - TRANSIENT: Temporary service issues (503, 502) → retry
 * - FATAL: Permanent errors (4xx except 429, malformed data) → don't retry
 */
@Injectable()
export class RetryStrategy {
  private readonly logger = new Logger(RetryStrategy.name);

  /**
   * Determine if a notification should be retried
   */
  getRetryDecision(
    error: Error | any,
    retryCount: number,
    maxRetries: number,
    eventType?: EventType,
  ): RetryDecision {
    const classification = this.classifyError(error);

    // Rate limited - always retry with backoff
    if (classification === ErrorClassification.RATE_LIMIT) {
      if (retryCount >= maxRetries) {
        return {
          shouldRetry: false,
          classification,
          nextDelayMs: 0,
          reason: 'Max retries exceeded (rate limited)',
        };
      }

      const delay = this.calculateBackoffDelay(retryCount, true, eventType);
      return {
        shouldRetry: true,
        classification,
        nextDelayMs: delay,
        reason: 'Rate limited - will retry with backoff',
      };
    }

    // Network errors - retry up to max
    if (classification === ErrorClassification.NETWORK) {
      if (retryCount >= maxRetries) {
        return {
          shouldRetry: false,
          classification,
          nextDelayMs: 0,
          reason: 'Max retries exceeded (network error)',
        };
      }

      const delay = this.calculateBackoffDelay(retryCount, true, eventType);
      return {
        shouldRetry: true,
        classification,
        nextDelayMs: delay,
        reason: 'Network error - will retry with exponential backoff',
      };
    }

    // Transient errors (5xx) - retry with caution
    if (classification === ErrorClassification.TRANSIENT) {
      if (retryCount >= maxRetries) {
        return {
          shouldRetry: false,
          classification,
          nextDelayMs: 0,
          reason: 'Max retries exceeded (transient error)',
        };
      }

      const delay = this.calculateBackoffDelay(retryCount, true, eventType);
      return {
        shouldRetry: true,
        classification,
        nextDelayMs: delay,
        reason: 'Transient error - will retry with backoff',
      };
    }

    // Fatal errors - no retry
    return {
      shouldRetry: false,
      classification,
      nextDelayMs: 0,
      reason: 'Fatal error - no retry',
    };
  }

  /**
   * Classify error type
   */
  private classifyError(error: Error | any): ErrorClassification {
    // Network-related errors
    const networkPatterns = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ENOTFOUND',
      'socket',
      'timeout',
    ];

    const errorMsg = error?.message?.toLowerCase() || '';
    const errorCode = error?.code?.toUpperCase() || '';
    const errorStatus = error?.response?.status;

    if (
      networkPatterns.some(
        (p) =>
          errorMsg.includes(p.toLowerCase()) ||
          errorCode.includes(p) ||
          errorMsg.includes(p.toLowerCase()),
      )
    ) {
      return ErrorClassification.NETWORK;
    }

    // Rate limit
    if (errorStatus === 429 || errorMsg.includes('rate')) {
      return ErrorClassification.RATE_LIMIT;
    }

    // Transient (5xx)
    if (errorStatus && errorStatus >= 500 && errorStatus < 600) {
      return ErrorClassification.TRANSIENT;
    }

    // Client errors (4xx except 429)
    if (errorStatus && errorStatus >= 400 && errorStatus < 500) {
      return ErrorClassification.FATAL;
    }

    // Validation errors, malformed data
    if (
      errorMsg.includes('validation') ||
      errorMsg.includes('invalid') ||
      errorMsg.includes('required')
    ) {
      return ErrorClassification.FATAL;
    }

    // Unknown user, not found
    if (
      errorMsg.includes('not found') ||
      errorMsg.includes('no user') ||
      errorStatus === 404
    ) {
      return ErrorClassification.FATAL;
    }

    // Default to transient (safer to retry)
    return ErrorClassification.TRANSIENT;
  }

  /**
   * Calculate exponential backoff delay in milliseconds
   * 
   * Formula: baseDelay * (multiplier ^ retryCount)
   * Capped at maxDelayMs
   */
  private calculateBackoffDelay(
    retryCount: number,
    isNetworkError: boolean = true,
    eventType?: EventType,
  ): number {
    // Get config based on priority
    let baseDelay = 2000; // 2 seconds
    let multiplier = 2;
    let maxDelay = 60000; // 1 minute

    if (eventType) {
      const config = PRIORITY_RETRY_CONFIG[eventType] || PRIORITY_RETRY_CONFIG.NORMAL;
      baseDelay = config.initialDelayMs;
      multiplier = config.backoffMultiplier;
    }

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * baseDelay * 0.1; // 10% jitter
    const exponentialDelay = baseDelay * Math.pow(multiplier, retryCount) + jitter;

    return Math.min(Math.floor(exponentialDelay), maxDelay);
  }

  /**
   * Get recommended max retries based on error type
   */
  getRecommendedMaxRetries(
    error: Error | any,
    eventType?: EventType,
  ): number {
    const classification = this.classifyError(error);

    if (eventType) {
      // Use priority-based config
      const priority = this.getEventPriority(eventType);
      return PRIORITY_RETRY_CONFIG[priority]?.maxRetries || 5;
    }

    // Default based on classification
    switch (classification) {
      case ErrorClassification.NETWORK:
        return 5;
      case ErrorClassification.RATE_LIMIT:
        return 7;
      case ErrorClassification.TRANSIENT:
        return 3;
      case ErrorClassification.FATAL:
        return 0;
    }
  }

  /**
   * Get event priority
   */
  private getEventPriority(eventType: EventType): 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' {
    const urgentEvents = [
      EventType.SECURITY_INCIDENT,
      EventType.USER_RESTRICTED,
      EventType.STAKE_SLASHED,
    ];

    const highEvents = [
      EventType.VERIFICATION_ASSIGNED,
      EventType.DISPUTE_ESCALATED,
      EventType.REPUTATION_PENALTY,
      EventType.MODERATOR_ACTION,
    ];

    if (urgentEvents.includes(eventType)) return 'URGENT';
    if (highEvents.includes(eventType)) return 'HIGH';

    return 'NORMAL';
  }

  /**
   * Log retry attempt
   */
  logRetryAttempt(
    notificationId: string,
    retryCount: number,
    nextDelayMs: number,
    error: Error,
  ): void {
    this.logger.warn(
      `Notification retry ${retryCount}: ${notificationId} (retry in ${nextDelayMs}ms) - ${error.message}`,
    );
  }

  /**
   * Log dead-letter
   */
  logDeadLetter(notificationId: string, error: Error, reason: string): void {
    this.logger.error(
      `Notification dead-lettered: ${notificationId} - ${reason} - ${error.message}`,
    );
  }
}
