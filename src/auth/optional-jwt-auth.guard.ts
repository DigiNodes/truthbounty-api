import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedPrincipal } from './types/authenticated-request';

/**
 * Optional JWT Auth Guard
 * Allows requests to proceed even without authentication
 * Useful for endpoints that can work with or without auth
 *
 * When authentication succeeds, the verified principal is attached to the
 * request by the JWT strategy. When it fails, the request proceeds as
 * anonymous -- and must not inherit a stale principal from any other source.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(
    err: unknown,
    user: AuthenticatedPrincipal | false | null | undefined,
    _info: unknown,
    _context: ExecutionContext,
  ): AuthenticatedPrincipal | null {
    // Return user if authenticated, null if not (don't throw error).
    // Never return a stale or malformed principal.
    if (err || !user || typeof user !== 'object') {
      return null;
    }
    return user as AuthenticatedPrincipal;
  }
}
