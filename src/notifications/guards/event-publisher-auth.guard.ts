import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ServiceAuthGuard } from '../../auth/guards/service-auth.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AdminGuard, ADMIN_ONLY_KEY } from '../../auth/guards/admin.guard';

export interface EventPublisherRequest {
  headers?: Record<string, string | string[] | undefined>;
  user?: {
    id?: string;
    userId?: string;
    sub?: string;
    address?: string;
    role?: string;
    roles?: string[];
    user?: {
      id?: string;
      role?: string;
    };
  };
  use?: EventPublisherRequest['user'];
  isServiceAuth?: boolean;
}

const SERVICE_API_KEY_HEADER = 'x-service-api-key';

function hasServiceApiKeyHeader(request: EventPublisherRequest): boolean {
  const value =
    request?.headers?.[SERVICE_API_KEY_HEADER] ??
    request?.headers?.[SERVICE_API_KEY_HEADER.toLowerCase()];
  if (Array.isArray(value)) {
    return value.some((v) => typeof v === 'string' && v.trim().length > 0);
  }
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Composite fail-closed guard for internal event publisher endpoints.
 *
 * Caller contract:
 * 1. Service-to-service: valid `x-service-api-key` header (validated via ServiceAuthGuard).
 *    If the header is present and invalid/unconfigured, fails closed with 401.
 * 2. Admin operator: valid JWT (JwtAuthGuard) + explicit `@AdminOnly()` metadata
 *    validated via AdminGuard. Fails closed if `@AdminOnly()` is missing or caller is not admin.
 */
@Injectable()
export class ServiceOrAdminGuard implements CanActivate {
  private readonly logger = new Logger(ServiceOrAdminGuard.name);

  constructor(
    private readonly serviceAuthGuard: ServiceAuthGuard,
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly adminGuard: AdminGuard,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EventPublisherRequest>();

    // Path 1: Service-to-service identity
    if (hasServiceApiKeyHeader(request)) {
      const serviceAllowed = this.serviceAuthGuard.canActivate(context);
      if (!serviceAllowed) {
        throw new UnauthorizedException('Invalid service API key');
      }
      request.isServiceAuth = true;
      return true;
    }

    // Path 2: Admin operator (JWT + explicit @AdminOnly() + AdminGuard)
    const jwtResult = await Promise.resolve(this.jwtAuthGuard.canActivate(context));
    if (!jwtResult) {
      throw new UnauthorizedException('Authentication required');
    }

    const isAdminOnly = this.reflector.getAllAndOverride<boolean>(
      ADMIN_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!isAdminOnly) {
      this.logger.error(
        'Fail-closed: ServiceOrAdminGuard invoked on route without @AdminOnly() metadata',
      );
      throw new ForbiddenException('Admin authorization policy not configured');
    }

    // Ensure AdminGuard can inspect the verified principal
    if (request.user && !request.use) {
      request.use = request.user;
    }

    const adminAllowed = this.adminGuard.canActivate(context);
    if (!adminAllowed) {
      throw new ForbiddenException('Admin privileges required');
    }

    return true;
  }
}

/**
 * Composite fail-closed guard for event-status lookups.
 *
 * Caller contract:
 * 1. Service-to-service: valid `x-service-api-key` header (ServiceAuthGuard).
 *    If present and invalid/unconfigured, fails closed with 401.
 * 2. Authenticated user (owner or admin): valid JWT (JwtAuthGuard).
 *    Ownership or admin capability is enforced by the controller/service.
 */
@Injectable()
export class ServiceOrJwtAuthGuard implements CanActivate {
  constructor(
    private readonly serviceAuthGuard: ServiceAuthGuard,
    private readonly jwtAuthGuard: JwtAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EventPublisherRequest>();

    if (hasServiceApiKeyHeader(request)) {
      const serviceAllowed = this.serviceAuthGuard.canActivate(context);
      if (!serviceAllowed) {
        throw new UnauthorizedException('Invalid service API key');
      }
      request.isServiceAuth = true;
      return true;
    }

    const jwtResult = await Promise.resolve(this.jwtAuthGuard.canActivate(context));
    if (!jwtResult) {
      throw new UnauthorizedException('Authentication required');
    }

    return true;
  }
}
