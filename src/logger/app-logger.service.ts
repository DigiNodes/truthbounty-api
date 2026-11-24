import { Injectable, LoggerService } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export interface LogContext {
  [key: string]: unknown;
}

/**
 * Application Logger Service - Provides structured JSON logging
 * Wraps Pino logger with additional context support
 */
@Injectable()
export class AppLoggerService implements LoggerService {
  constructor(private readonly logger: PinoLogger) {}

  /**
   * Set the context for subsequent log messages
   */
  setContext(context: string): void {
    this.logger.setContext(context);
  }

  /**
   * Log at info level
   */
  log(message: string, context?: LogContext | string): void {
    if (typeof context === 'string') {
      this.logger.info({ context }, message);
    } else {
      this.logger.info(context || {}, message);
    }
  }

  /**
   * Log at error level with optional error object
   */
  error(message: string, trace?: string, context?: LogContext | string): void {
    const meta: LogContext = {};

    if (trace) {
      meta.trace = trace;
    }

    if (typeof context === 'string') {
      meta.context = context;
    } else if (context) {
      Object.assign(meta, context);
    }

    this.logger.error(meta, message);
  }

  /**
   * Log at warn level
   */
  warn(message: string, context?: LogContext | string): void {
    if (typeof context === 'string') {
      this.logger.warn({ context }, message);
    } else {
      this.logger.warn(context || {}, message);
    }
  }

  /**
   * Log at debug level
   */
  debug(message: string, context?: LogContext | string): void {
    if (typeof context === 'string') {
      this.logger.debug({ context }, message);
    } else {
      this.logger.debug(context || {}, message);
    }
  }

  /**
   * Log at verbose/trace level
   */
  verbose(message: string, context?: LogContext | string): void {
    if (typeof context === 'string') {
      this.logger.trace({ context }, message);
    } else {
      this.logger.trace(context || {}, message);
    }
  }

  // Domain-specific logging methods for key events

  /**
   * Log claim-related events
   */
  logClaimEvent(
    action: 'created' | 'updated' | 'resolved' | 'disputed',
    claimId: string,
    data?: LogContext,
  ): void {
    this.logger.info(
      { domain: 'claim', action, claimId, ...data },
      `Claim ${action}: ${claimId}`,
    );
  }

  /**
   * Log evidence-related events
   */
  logEvidenceEvent(
    action: 'submitted' | 'flagged' | 'verified',
    evidenceId: string,
    claimId: string,
    data?: LogContext,
  ): void {
    this.logger.info(
      { domain: 'evidence', action, evidenceId, claimId, ...data },
      `Evidence ${action}: ${evidenceId}`,
    );
  }

  /**
   * Log blockchain-related events
   */
  logBlockchainEvent(
    action: 'indexed' | 'reorg' | 'synced' | 'error',
    data: LogContext,
  ): void {
    const level = action === 'error' ? 'error' : 'info';
    this.logger[level](
      { domain: 'blockchain', action, ...data },
      `Blockchain ${action}`,
    );
  }

  /**
   * Log identity/auth events
   */
  logIdentityEvent(
    action: 'verified' | 'created' | 'updated' | 'failed',
    walletAddress: string,
    data?: LogContext,
  ): void {
    this.logger.info(
      { domain: 'identity', action, walletAddress, ...data },
      `Identity ${action}: ${walletAddress.slice(0, 10)}...`,
    );
  }

  /**
   * Log dispute-related events
   */
  logDisputeEvent(
    action: 'created' | 'resolved' | 'escalated',
    disputeId: string,
    data?: LogContext,
  ): void {
    this.logger.info(
      { domain: 'dispute', action, disputeId, ...data },
      `Dispute ${action}: ${disputeId}`,
    );
  }

  /**
   * Log reward-related events
   */
  logRewardEvent(
    action: 'calculated' | 'distributed' | 'claimed',
    data: LogContext,
  ): void {
    this.logger.info({ domain: 'reward', action, ...data }, `Reward ${action}`);
  }

  /**
   * Log performance metrics
   */
  logPerformance(
    operation: string,
    durationMs: number,
    data?: LogContext,
  ): void {
    this.logger.info(
      { domain: 'performance', operation, durationMs, ...data },
      `${operation} completed in ${durationMs}ms`,
    );
  }

  /**
   * Log security events
   */
  logSecurityEvent(
    event:
      'rate_limited' | 'sybil_detected' | 'invalid_signature' | 'unauthorized',
    data: LogContext,
  ): void {
    this.logger.warn(
      { domain: 'security', event, ...data },
      `Security event: ${event}`,
    );
  }
}
