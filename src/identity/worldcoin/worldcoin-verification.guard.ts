import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';

/**
 * WorldcoinVerificationGuard
 *
 * Enforces that the authenticated principal can only submit a Worldcoin proof
 * for their own userId.  Prevents one authenticated user from claiming the
 * Worldcoin credential on behalf of another user (IDOR).
 *
 * Security contract:
 *  - No authenticated principal → 401 Unauthorized (fail closed)
 *  - Authenticated principal but body.userId !== principal.sub/userId → 403
 *  - Authenticated principal and body.userId matches → allow through
 *
 * Placement: must run AFTER JwtAuthGuard so that request.user is populated.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, WorldcoinVerificationGuard)
 *   @Post('verify')
 */
@Injectable()
export class WorldcoinVerificationGuard implements CanActivate {
  private readonly logger = new Logger(WorldcoinVerificationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      user?: { sub?: string; userId?: string };
      body?: { userId?: string };
    }>();

    // Fail closed: no authenticated principal — JWT guard should have caught
    // this first, but we check here defensively.
    if (!request.user || typeof request.user !== 'object') {
      this.logger.warn('worldcoin.guard.no_principal');
      throw new UnauthorizedException('Authentication required');
    }

    const principalId: string | undefined =
      request.user.sub ?? request.user.userId;

    if (!principalId) {
      this.logger.warn('worldcoin.guard.principal_missing_id');
      throw new UnauthorizedException('Authentication required');
    }

    // Body userId must match the authenticated principal.
    // This prevents IDOR: user A cannot submit a proof that gets attributed
    // to user B's account.
    const bodyUserId: string | undefined = request.body?.userId;

    if (!bodyUserId) {
      // If no userId in body the controller will fail on its own; here we just
      // let it through — the body-level class-validator will reject it.
      return true;
    }

    if (bodyUserId !== principalId) {
      // Never log the actual user IDs (enumeration risk).
      this.logger.warn(
        'worldcoin.guard.user_id_mismatch [principal vs body]',
      );
      throw new ForbiddenException(
        'You may only submit a Worldcoin proof for your own account',
      );
    }

    return true;
  }
}
