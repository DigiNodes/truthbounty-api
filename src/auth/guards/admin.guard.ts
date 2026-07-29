import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Metadata key for marking endpoints as admin-only.
 */
export const ADMIN_ONLY_KEY = 'adminOnly';

/**
 * Admin Guard
 *
 * Protects endpoints that require admin privileges.
 * Checks for an 'admin' role in the JWT payload or a configured admin wallet list.
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
    const raw = process.env.ADMIN_WALLETS || '';
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

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      this.logger.warn('Admin access denied: no authenticated user');
      throw new ForbiddenException('Authentication required for admin access');
    }

    // Check if user has admin role from JWT
    if (user.roles && Array.isArray(user.roles) && user.roles.includes('admin')) {
      return true;
    }

    // Check if wallet address is in admin list
    const userAddress = user.address?.toLowerCase();
    if (userAddress && this.adminAddresses.has(userAddress)) {
      return true;
    }

    // Check userId-based admin list
    const userId = user.userId || user.sub;
    if (userId && this.adminAddresses.has(userId)) {
      return true;
    }

    this.logger.warn(
      `Admin access denied for user: ${userAddress || userId || 'unknown'}`,
    );
    throw new ForbiddenException('Admin privileges required');
  }
}
