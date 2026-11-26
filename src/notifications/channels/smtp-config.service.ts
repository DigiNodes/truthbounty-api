import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SMTP Configuration
 * 
 * Validated SMTP connection parameters for nodemailer transport.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  from: {
    name: string;
    address: string;
  };
  connectionTimeout: number;
  greetingsTimeout: number;
}

/**
 * SmtpConfigService
 * 
 * Centralizes SMTP configuration validation and provides typed config objects.
 * Ensures all required SMTP settings are present before attempting connections.
 * 
 * Security: Never logs passwords or credentials.
 */
@Injectable()
export class SmtpConfigService {
  private readonly logger = new Logger(SmtpConfigService.name);
  private cachedConfig: SmtpConfig | null = null;
  private validationErrors: string[] = [];

  constructor(private configService: ConfigService) {}

  /**
   * Validate SMTP configuration and return typed config object.
   * Returns null if configuration is incomplete or invalid.
   */
  validateConfig(): { valid: boolean; errors: string[]; config?: SmtpConfig } {
    const errors: string[] = [];

    // Required fields
    const host = this.configService.get<string>('SMTP_HOST');
    const port = this.configService.get<number>('SMTP_PORT');
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASSWORD') || 
                  this.configService.get<string>('SMTP_PASS');
    const from = this.configService.get<string>('SMTP_FROM') ||
                  this.configService.get<string>('NOTIFICATION_EMAIL_FROM');

    // Validate required fields
    if (!host) {
      errors.push('SMTP_HOST is required');
    }

    if (!port) {
      errors.push('SMTP_PORT is required');
    } else if (port < 1 || port > 65535) {
      errors.push('SMTP_PORT must be between 1 and 65535');
    }

    if (!user) {
      errors.push('SMTP_USER is required');
    }

    if (!pass) {
      errors.push('SMTP_PASSWORD (or SMTP_PASS) is required');
    }

    if (!from) {
      errors.push('SMTP_FROM (or NOTIFICATION_EMAIL_FROM) is required');
    }

    // If any required field is missing, return early
    if (errors.length > 0) {
      this.validationErrors = errors;
      return { valid: false, errors };
    }

    // Optional fields with defaults
    const secure = this.configService.get<boolean>('SMTP_SECURE', false);
    const fromName = this.configService.get<string>('SMTP_FROM_NAME', 'TruthBounty');
    const connectionTimeout = this.configService.get<number>('SMTP_CONNECTION_TIMEOUT', 10000);
    const greetingsTimeout = this.configService.get<number>('SMTP_GREETINGS_TIMEOUT', 5000);

    const config: SmtpConfig = {
      host: host!,
      port: port!,
      secure,
      auth: {
        user: user!,
        pass: pass!,
      },
      from: {
        name: fromName,
        address: from!,
      },
      connectionTimeout,
      greetingsTimeout,
    };

    this.cachedConfig = config;
    this.validationErrors = [];
    
    return { valid: true, errors: [], config };
  }

  /**
   * Check if SMTP is configured (cached result after first validation)
   */
  isConfigured(): boolean {
    if (this.cachedConfig) {
      return true;
    }

    const result = this.validateConfig();
    return result.valid;
  }

  /**
   * Get validated SMTP configuration.
   * Returns null if configuration is invalid.
   */
  getConfig(): SmtpConfig | null {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    const result = this.validateConfig();
    return result.config || null;
  }

  /**
   * Get configuration errors from last validation
   */
  getErrors(): string[] {
    return [...this.validationErrors];
  }
}
