import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IDEMPOTENT_KEY } from './idempotent.decorator';

@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check if the endpoint is marked as requiring idempotency
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If not marked as idempotent, allow access
    if (!isIdempotent) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['idempotency-key'] as string;

    // If no idempotency key is provided, deny access
    if (!idempotencyKey) {
      throw new UnauthorizedException('Idempotency key is required for this operation');
    }

    return true;
  }
}
