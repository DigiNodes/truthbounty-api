import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AiResponseEnvelope } from '../interfaces/ai-response-envelope.interface';
import { AiMetricsService } from '../../metrics/ai-metrics.service';
import { SafetyGuardrailService } from '../../services/safety-guardrail.service';

/**
 * Maps errors thrown within the AI-assistant module to the same
 * AiResponseEnvelope shape AiResponseInterceptor produces on success.
 * Module-scoped (@UseFilters on the AI controllers), not a repo-wide
 * APP_FILTER — no such convention exists elsewhere in this repo.
 */
@Catch()
export class AiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AiExceptionFilter.name);

  constructor(
    private readonly metrics: AiMetricsService,
    private readonly safetyGuardrailService: SafetyGuardrailService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const requestId: string = request.id || crypto.randomUUID();
    const timestamp = new Date().toISOString();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred. Please try again later.';

    if (exception instanceof ThrottlerException) {
      status = HttpStatus.TOO_MANY_REQUESTS;
      code = 'RATE_LIMITED';
      message = exception.message;
      const throttleType = request.route?.path?.includes('stream')
        ? 'aiStream'
        : 'ai';
      this.metrics.recordRateLimited(throttleType);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = exception.constructor.name.replace(/Exception$/, '').toUpperCase();
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : ((body as any)?.message ?? exception.message);
    } else {
      const rawMessage =
        exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `Unhandled error: ${this.safetyGuardrailService.redact(rawMessage).text}`,
      );
    }

    if (exception instanceof HttpException) {
      this.logger.warn(`[${requestId}] ${status} ${code}: ${message}`);
    }

    const envelope: AiResponseEnvelope = {
      success: false,
      requestId,
      timestamp,
      data: null,
      error: {
        code,
        message: Array.isArray(message) ? message.join(', ') : message,
      },
    };

    response.status(status).json(envelope);
  }
}
