import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppUserRole, ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Authorizes routes decorated with @Roles(...). Must run after JwtAuthGuard,
 * since it reads request.user (set by JwtStrategy.validate -> AuthService.validateToken),
 * shape: { address, userId, user: PrismaUser | null }.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppUserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const role: AppUserRole | undefined = request.user?.user?.role;

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException(
        `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
