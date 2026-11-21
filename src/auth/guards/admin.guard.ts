import { getRuntimeEnvironment } from '../../config/runtime-config';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthenticatedRequest,
  isAuthenticatedRequest,
} from '../types/authenticated-request';

/**
 * Metadata key for marking endpoints as admin-only.
 */
export const ADMIN_ONLY_KEY = 'adminOnly';

/**
 * Admin Guard
 *
 * Protects endpoints that require admin privileges.
 * Checks for an 'admin' role in the verified principal or a configured admin
 * wallet list.
 *
 * This guard is part of the app-user authorization plane and reads the
 * principal attached by JwtStrategy at request.user. It supports a compatibility
 * fallback to request.use if that legacy field is present.
 *
 * The principal structure comes from AuthService.validateToken and includes:
 * - address: string (required)
 * - userId: string | null
 * - user: { id: string, role: string } | null
 * - sub: string (optional)
 * - jti: string (optional)
 *
 * The admin role check examines principal.user.role (a string), not a roles array.
 *
 * Usage:
 *   @UseGuards(AdminGuard)
 *   @AdminOnly()
 *   @Post('admin/some-endpoint')
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  /** Wallet addresses that have admin privileges. Configured via ADMIN_WALLETS env. */
  private readonly adminAddresses: Set<string>;

  constructor(private readonly reflector: Reflector) {
    const raw = getRuntimeEnvironment().ADMIN_WALLETS || '';
    this.adminAddresses = new Set(
      raw
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const isAdminOnly = this.reflector.getAllAndOverride<boolean>(
      ADMIN_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If not explicitly marked as admin-only, allow through
    if (!isAdminOnly) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    if (!isAuthenticatedRequest(request)) {
      this.logger.warn('Admin access denied: no authenticated user');
      throw new ForbiddenException('Authentication required for admin access');
    }

    // Read the canonical principal from request.user (set by JwtStrategy).
    // Fall back to request.use for compatibility if request.user is absent.
    const authReq = request as AuthenticatedRequest;
    const principal = authReq.user || authReq.use;

    if (!principal) {
      this.logger.warn('Admin access denied: no authenticated user');
      throw new ForbiddenException('Authentication required for admin access');
    }

    // Validate that the principal has a required address field
    if (!principal.address) {
      this.logger.warn('Admin access denied: missing address in principal');
      throw new ForbiddenException('Authentication required for admin access');
    }

    // Check if user has admin role from the verified principal.
    // The role is nested as principal.user.role (not a roles array).
    const role = principal.user?.role;
    if (role === 'admin') {
      return true;
    }

    // Check if wallet address is in admin list
    const userAddress = principal.address.toLowerCase();
    if (this.adminAddresses.has(userAddress)) {
      return true;
    }

    // Check userId-based admin list
    const userId = principal.userId || principal.sub;
    if (userId && this.adminAddresses.has(userId)) {
      return true;
    }

    this.logger.warn(
      `Admin access denied for user: ${userAddress || userId || 'unknown'}`,
    );
    throw new ForbiddenException('Admin privileges required');
  }
}
