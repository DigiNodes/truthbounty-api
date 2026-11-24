import { Injectable, Logger as NestLoggerService } from '@nestjs/common';
import { RedactionService } from './redaction.service';
import {
  LogEvent,
  LogEventInput,
  LogLevel,
  normalizeLogEvent,
} from './log-event.schema';
import {
  CorrelationContext,
  getCorrelationContext,
} from './correlation.context';

/**
 * Structured logger that funnels every event through the centralized
 * redaction boundary before emitting JSON output.
 */
@Injectable()
export class StructuredLoggerService {
  private readonly nestLogger = new NestLoggerService('StructuredLogger');

  constructor(private readonly redaction: RedactionService) {}

  debug(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', event, message, data);
  }

  info(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', event, message, data);
  }

  warn(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', event, message, data);
  }

  error(
    event: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void {
    this.log('error', event, message, data, error);
  }

  fatal(
    event: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void {
    this.log('fatal', event, message, data, error);
  }

  /**
   * Emit a log event through the redaction boundary. Returns the final,
   * redacted event for testing and transport integration.
   */
  log(
    level: LogLevel,
    event: string,
    message: string,
    data?: Record<string, unknown>,
    error?: unknown,
    context: CorrelationContext = getCorrelationContext(),
  ): LogEvent {
    const input: LogEventInput = {
      level,
      event,
      message,
      data,
      error,
    };
    const normalized = normalizeLogEvent(input, context);
    const redacted = this.redaction.redactRecord(
      normalized as unknown as Record<string, unknown>,
    ) as LogEvent;
    this.emit(redacted);
    return redacted;
  }

  /**
   * Serialize and dispatch the redacted event to Nest's logger.
   */
  private emit(event: LogEvent): void {
    const serialized = JSON.stringify(event);
    switch (event.level) {
      case 'debug':
        this.nestLogger.debug(serialized);
        break;
      case 'info':
        this.nestLogger.log(serialized);
        break;
      case 'warn':
        this.nestLogger.warn(serialized);
        break;
      case 'error':
        this.nestLogger.error(serialized);
        break;
      case 'fatal':
        this.nestLogger.error(serialized);
        break;
      default:
        this.nestLogger.log(serialized);
    }
  }
}
