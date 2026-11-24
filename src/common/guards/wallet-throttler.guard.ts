import { Injectable, ExecutionContext, Logger, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import { WalletRateLimiterService } from '../../auth/wallet-rate-limiter.service';

@Injectable()
export class WalletThrottlerGuard {
  private readonly logger = new Logger(WalletThrottlerGuard.name);

  constructor(
    @Optional()
    private readonly walletRateLimiterService?: WalletRateLimiterService,
    protected readonly reflector?: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skipThrottle = this.reflector?.getAllAndOverride<boolean>(
      'skipThrottle',
      [context.getHandler(), context.getClass()],
    );
    if (skipThrottle) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    if (!this.walletRateLimiterService) {
      return true;
    }

    try {
      const result = await this.walletRateLimiterService.checkRateLimit(request);

      const headers = this.walletRateLimiterService.getRateLimitHeaders(result);
      if (response && typeof response.setHeader === 'function') {
        for (const [key, value] of Object.entries(headers)) {
          response.setHeader(key, value);
        }
      }

      if (!result.allowed) {
        throw new ThrottlerException(
          `Rate limit exceeded. Try again in ${Math.ceil((result.retryAfterMs || 60000) / 1000)} seconds.`,
        );
      }

      return true;
    } catch (error) {
      if (error instanceof ThrottlerException) {
        throw error;
      }
      this.logger.error(`WalletThrottlerGuard security check failed: ${error.message}. Failing closed.`);
      throw new ThrottlerException('Rate limit security check failed. Access denied (Fail Closed).');
    }
  }
}
