import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
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

    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException(
        'Invalid authorization scheme. Use Bearer token',
      );
    }

    if (token !== metricsToken) {
      throw new UnauthorizedException('Invalid metrics token');
    }

    return true;
  }
}
