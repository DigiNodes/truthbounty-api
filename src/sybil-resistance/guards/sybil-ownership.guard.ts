import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';

/**
 * SybilOwnershipGuard
 *
 * Enforces that an authenticated user may only act on their **own** `:userId`
 * path parameter.  Prevents IDOR: user A cannot trigger score writes or
 * appeal submissions that target user B's account.
 *
 * Security contract (fail-closed):
 *  - No authenticated principal → 401 Unauthorized
 *  - Principal present but its stable ID cannot be resolved → 401
 *  - Principal ID does not match the `:userId` route param → 403 Forbidden
 *  - Principal ID matches → allow through
 *
 * Placement: must run AFTER `JwtAuthGuard` so that `request.user` is populated.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, SybilOwnershipGuard)
 *   @Post('users/:userId/appeal')
 */
@Injectable()
export class SybilOwnershipGuard implements CanActivate {
  private readonly logger = new Logger(SybilOwnershipGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: { sub?: string; userId?: string };
      params?: { userId?: string };
    }>();

    // Fail closed: no authenticated principal.
    if (!request.user || typeof request.user !== 'object') {
      this.logger.warn('sybil.ownership.no_principal');
      throw new UnauthorizedException('Authentication required');
    }

    // Resolve the stable identity from the JWT principal.
    const principalId: string | undefined =
      request.user.sub ?? request.user.userId;

    if (!principalId) {
      this.logger.warn('sybil.ownership.principal_missing_id');
      throw new UnauthorizedException('Authentication required');
    }

    // The route parameter :userId must match the authenticated principal.
    const routeUserId: string | undefined = request.params?.userId;

    if (!routeUserId) {
      // No :userId in the route — this guard is not applicable; pass through.
      return true;
    }

    if (routeUserId !== principalId) {
      // Never log actual user IDs (enumeration risk).
      this.logger.warn(
        'sybil.ownership.user_id_mismatch [principal vs route param]',
      );
      throw new ForbiddenException(
        'You may only perform this operation on your own account',
      );
    }

    return true;
  }
}
