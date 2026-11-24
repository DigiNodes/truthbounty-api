import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Required JWT Auth Guard.
 *
 * Runs the verified JWT strategy and attaches the canonical
 * `AuthenticatedPrincipal` to `request.user`. Any failure fails closed.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
