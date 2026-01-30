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
export const ThrottleByWallet = (type: 'claims' | 'votes' | 'disputes') =>
    SetMetadata(THROTTLE_TYPE_KEY, type);
