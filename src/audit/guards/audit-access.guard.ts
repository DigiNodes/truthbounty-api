import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../entities/user.entity';

export const AUDIT_ACCESS_KEY = 'audit_access';
export enum AuditAccessLevel {
  VIEW = 'VIEW',
  EXPORT = 'EXPORT',
  MANAGE = 'MANAGE',
}

@Injectable()
export class AuditAccessGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredLevel = this.reflector.getAllAndOverride<AuditAccessLevel>(
      AUDIT_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredLevel) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const role = user.role;

    switch (requiredLevel) {
      case AuditAccessLevel.VIEW:
        if (role === UserRole.USER) {
          const requestedUserId = request.params.userId || request.query.userId;
          if (requestedUserId && requestedUserId !== user.id) {
            throw new ForbiddenException('Insufficient permissions to view audit data');
          }
        }
        return true;

      case AuditAccessLevel.EXPORT:
        if (![UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(role)) {
          throw new ForbiddenException('Insufficient permissions to export audit data');
        }
        return true;

      case AuditAccessLevel.MANAGE:
        if (![UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(role)) {
          throw new ForbiddenException('Insufficient permissions to manage audit data');
        }
        return true;

      default:
        return true;
    }
  }
}

export function AuditAccess(level: AuditAccessLevel) {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(AUDIT_ACCESS_KEY, level, descriptor.value);
    return descriptor;
  };
}
