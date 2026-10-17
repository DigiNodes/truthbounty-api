import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { getRuntimeConfig } from './runtime-config';
import { runtimeConfigSummary } from './runtime-schema';

/** Compatibility facade; validation happens once before Nest bootstrap. */
@Injectable()
export class EnvironmentValidationService implements OnModuleInit {
  private readonly logger = new Logger(EnvironmentValidationService.name);
  onModuleInit(): void {
    this.validateAll();
  }
  validateAll(): void {
    getRuntimeConfig();
    this.logger.log('Runtime configuration validated');
  }
  getValidationSummary(): Readonly<Record<string, string>> {
    return runtimeConfigSummary(getRuntimeConfig());
  }
}
