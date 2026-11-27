import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqualUtf8 } from '../common/utils/timing-safe.util';
import { isMetricsExplicitlyDisabled } from './metrics-enabled';

@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const metricsEnabled = this.configService.get<string>('METRICS_ENABLED');

    if (isMetricsExplicitlyDisabled(metricsEnabled)) {
      throw new NotFoundException('Not Found');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const metricsToken = this.configService.get<string>('METRICS_TOKEN');

    // If no token is configured, allow access (for backward compatibility)
    if (!metricsToken) {
      return true;
    }

    // Check for Bearer token in Authorization header
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Missing authorization header');
    }

    // Node may expose repeated headers as an array, while some proxies join
    // them with commas. Neither representation is a single bearer credential.
    if (typeof authHeader !== 'string') {
      throw new UnauthorizedException(
        'Invalid authorization scheme. Use Bearer token',
      );
    }

    const match = /^Bearer ([^\s]+)$/.exec(authHeader);
    const token = match?.[1];

    if (!token || token.includes(',')) {
      throw new UnauthorizedException(
        'Invalid authorization scheme. Use Bearer token',
      );
    }

    if (!timingSafeEqualUtf8(token, metricsToken)) {
      throw new UnauthorizedException('Invalid metrics token');
    }

    return true;
  }
}
