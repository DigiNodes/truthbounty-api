import { Global, Module } from '@nestjs/common';
import { RedactionService } from './redaction.service';
import { StructuredLoggerService } from './logger.service';
import { CorrelationContext } from './correlation.context';
import { RedactionInterceptor } from './redaction.interceptor';

/**
 * Global logging module. Exposes the centralized redaction boundary and
 * the structured logger to all feature modules.
 */
@Global()
@Module({
  providers: [RedactionService, StructuredLoggerService, CorrelationContext, RedactionInterceptor],
  exports: [RedactionService, StructuredLoggerService, CorrelationContext, RedactionInterceptor],
})
export class LoggingModule {}
