import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  PUBLIC_INCIDENT_OPTIONS,
  PublicIncidentOptions,
  loadPublicIncidentOptions,
} from './public-incidents.options';

const MAX_TRACKED_CLIENTS = 10_000;

/**
 * Fixed-window, per-client-IP rate limit guard for public incident endpoints.
 */
@Injectable()
export class PublicIncidentRateLimitGuard implements CanActivate {
  private readonly options: PublicIncidentOptions;
  private readonly windows = new Map<
    string,
    { count: number; resetAtMs: number }
  >();

  constructor(
    @Optional()
    @Inject(PUBLIC_INCIDENT_OPTIONS)
    options?: PublicIncidentOptions,
    @Optional() private readonly clock: () => number = Date.now,
  ) {
    this.options = options ?? loadPublicIncidentOptions();
  }

  canActivate(context: ExecutionContext): boolean {
    const { rateLimit, rateLimitWindowSeconds } = this.options;
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const client = request.ip ?? 'unknown';
    const now = this.clock();

    if (this.windows.size > MAX_TRACKED_CLIENTS) {
      this.evictExpired(now);
    }

    let window = this.windows.get(client);
    if (!window || now >= window.resetAtMs) {
      window = { count: 0, resetAtMs: now + rateLimitWindowSeconds * 1000 };
      this.windows.set(client, window);
    }
    window.count++;

    const remaining = Math.max(0, rateLimit - window.count);
    const resetSeconds = Math.ceil((window.resetAtMs - now) / 1000);

    if (response && typeof response.setHeader === 'function') {
      response.setHeader('X-RateLimit-Limit', String(rateLimit));
      response.setHeader('X-RateLimit-Remaining', String(remaining));
      response.setHeader('X-RateLimit-Reset', String(resetSeconds));
    }

    if (window.count > rateLimit) {
      if (response && typeof response.setHeader === 'function') {
        response.setHeader('Retry-After', String(resetSeconds));
      }
      throw new ThrottlerException('Public incidents rate limit exceeded.');
    }

    return true;
  }

  private evictExpired(now: number): void {
    for (const [client, window] of this.windows) {
      if (now >= window.resetAtMs) {
        this.windows.delete(client);
      }
    }
  }
}
