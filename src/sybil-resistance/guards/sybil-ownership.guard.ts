import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthenticatedRequest,
  isAuthenticatedRequest,
} from '../../auth/types/authenticated-request';

/**
 * PREWAVE-BE-150: Sybil Ownership and Privileged Access Guard
 *
 * Enforces that:
 * 1. The caller is authenticated via JWT (fails closed if unauthenticated).
 * 2. The caller is either:
 *    a) The owner of the targeted user resource (principal.userId === targetUserId), or
 *    b) A privileged operator with 'moderator' or 'admin' role.
 *
 * Any other caller is denied with ForbiddenException.
 */
@Injectable()
export class SybilOwnershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<any>();

    // Fail closed: Must be authenticated
    if (!isAuthenticatedRequest(request)) {
      throw new UnauthorizedException('Authentication required');
    }

    const principal = (request as AuthenticatedRequest).user;
    const targetUserId =
      request.params?.userId || request.params?.id || request.body?.userId;

    // If targetUserId is missing or empty, allow through to controller's param validation
    if (!targetUserId || typeof targetUserId !== 'string' || !targetUserId.trim()) {
      return true;
    }

    const callerId = principal.userId || principal.user?.id;
    const isOwner = callerId !== undefined && callerId !== null && callerId === targetUserId;

    const role = principal.user?.role;
    const isPrivileged = role === 'admin' || role === 'moderator';

    if (!isOwner && !isPrivileged) {
      throw new ForbiddenException(
        'Access denied: You do not have permission to access or modify this user\'s Sybil data',
      );
    }

    return true;
  }
}
