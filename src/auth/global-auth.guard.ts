import { Injectable, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global Authentication Guard
 * Protects all POST, PATCH, DELETE, PUT endpoints
 * Allows GET endpoints to remain public unless specifically protected
 */
@Injectable()
export class GlobalAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If marked as public, allow access
    if (isPublic) {
      return true;
    }

    // Only require auth for mutation methods
    const method = request.method?.toUpperCase();
    const mutationMethods = ['POST', 'PATCH', 'DELETE', 'PUT'];

    if (mutationMethods.includes(method)) {
      return super.canActivate(context);
    }

    // GET and other read methods are public by default
    return true;
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new ForbiddenException('Authentication required for this operation');
    }
    return user;
  }
}
