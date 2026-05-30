import { SetMetadata } from '@nestjs/common';
import { THROTTLE_TYPE_KEY } from '../guards/wallet-throttler.guard';

/**
 * Decorator to specify the rate limit type for an endpoint.
 * Types: 'claims', 'votes', 'disputes'
 *
 * @example
 * @ThrottleByWallet('claims')
 * @Post('claims')
 * createClaim() { ... }
 */
export type ThrottleType = 'claims' | 'votes' | 'disputes' | 'auth';

export const ThrottleByWallet = (type: ThrottleType) =>
    SetMetadata(THROTTLE_TYPE_KEY, type);
