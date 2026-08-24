import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AdminRole, AdminRoleHierarchy } from '../entities/admin.entity';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const admin = request.admin;

    if (!admin) {
      throw new ForbiddenException('Admin access required');
    }

    if (!admin.isActive) {
      throw new ForbiddenException('Admin account is deactivated');
    }

    const hasRole = requiredRoles.some((role) => {
      return AdminRoleHierarchy[admin.role] >= AdminRoleHierarchy[role];
    });

    if (!hasRole) {
      throw new ForbiddenException(
        `Insufficient role. Required: ${requiredRoles.join(', ')}. Current: ${admin.role}`,
      );
    }

    return true;
  }
}
