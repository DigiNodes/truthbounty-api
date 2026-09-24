import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Service-to-Service Authentication Guard
 *
 * Protects internal endpoints that are called by other backend services.
 * Uses a shared API key (SERVICE_API_KEY) validated via constant-time comparison.
 *
 * Usage:
 *   @UseGuards(ServiceAuthGuard)
 *   @Post('internal/some-endpoint')
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAuthGuard.name);
  private readonly validApiKey: string;
  private readonly apiKeyHeader = 'x-service-api-key';

  constructor(private readonly configService: ConfigService) {
    this.validApiKey = configService.get<string>('SERVICE_API_KEY', '');
    if (!this.validApiKey) {
      this.logger.warn(
        'SERVICE_API_KEY not configured — service-to-service auth will reject all requests',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const providedKey =
      request.headers?.[this.apiKeyHeader] ||
      request.headers?.[this.apiKeyHeader.toLowerCase()] ||
      '';

    if (!providedKey) {
      this.logger.warn(
        `Service auth denied: missing API key header (${this.apiKeyHeader})`,
      );
      throw new UnauthorizedException('Service API key required');
    }

    if (!this.validApiKey) {
      this.logger.error('Service auth misconfigured: no API key set');
      throw new UnauthorizedException('Service authentication not configured');
    }

    // Constant-time comparison to prevent timing attacks
    if (!this.constantTimeEquals(providedKey, this.validApiKey)) {
      this.logger.warn('Service auth denied: invalid API key');
      throw new UnauthorizedException('Invalid service API key');
    }

    return true;
  }

  private constantTimeEquals(a: string, b: string): boolean {
    const aBuffer = Buffer.from(a, 'utf8');
    const bBuffer = Buffer.from(b, 'utf8');

    if (aBuffer.length !== bBuffer.length) {
      // Use a dummy comparison to avoid leaking length via timing
      const dummy = Buffer.from(b, 'utf8');
      try {
        timingSafeEqual(aBuffer, aBuffer); // This always returns true
        return false;
      } catch {
        return false;
      }
    }

    try {
      return timingSafeEqual(aBuffer, bBuffer);
    } catch {
      return false;
    }
  }
}
