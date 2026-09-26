import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppUserRole, ROLES_KEY } from '../decorators/roles.decorator';

/**
 * App-User Roles Guard (app-user plane).
 *
 * Reads the `@Roles(...)` metadata set by the app-user decorator and enforces
 * that `request.user.user.role` (Prisma UserRole) is in the required set.
 *
 * Must run AFTER JwtAuthGuard so that `request.user` is populated.
 *
 * Failure-closed: throws ForbiddenException for any missing or unrecognised identity.
 *
 * @see authorization-matrix.ts for the canonical route–role mapping.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppUserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No role restriction on this route — allow through.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // Fail closed: if the JWT strategy did not attach a user, deny.
    const authUser = request.user;
    if (!authUser) {
      throw new ForbiddenException('Authentication required');
    }

    // The Prisma UserRole is nested as request.user.user.role
    // (set by JwtStrategy → AuthService.validateToken).
    const role: AppUserRole | undefined = authUser.user?.role;

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException(
        `Access denied. Required role(s): ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
