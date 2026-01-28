import { Injectable, ExecutionContext, Inject } from '@nestjs/common';
import {
    ThrottlerGuard,
    ThrottlerException,
    ThrottlerStorage,
    ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerConfig } from '../../config/throttler.config';

export const THROTTLE_TYPE_KEY = 'throttle_type';

@Injectable()
export class WalletThrottlerGuard extends ThrottlerGuard {
    constructor(
        @Inject('THROTTLER:MODULE_OPTIONS')
        protected readonly options: ThrottlerModuleOptions,
        @Inject(ThrottlerStorage)
        protected readonly storageService: ThrottlerStorage,
        protected readonly reflector: Reflector,
        private readonly configService: ConfigService,
    ) {
        super(options, storageService, reflector);
    }

    protected async getTracker(req: Record<string, any>): Promise<string> {
        // Extract wallet address from various sources
        const walletAddress =
            req.headers?.['x-wallet-address'] ||
            req.body?.walletAddress ||
            req.body?.wallet ||
            req.query?.walletAddress ||
            req.query?.wallet ||
            req.ip; // Fallback to IP if no wallet provided

        return walletAddress;
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const tracker = await this.getTracker(request);

        // Get throttle type from metadata if set
        const throttleType = this.reflector.get<string>(
            THROTTLE_TYPE_KEY,
            context.getHandler(),
        );

        // Get config based on type
        const config = this.configService.get<ThrottlerConfig>('throttler');
        let limit = config?.default?.limit ?? 10;
        let ttl = config?.default?.ttl ?? 60000;

        if (config && throttleType) {
            const typeConfig = config[throttleType as keyof ThrottlerConfig];
            if (
                typeConfig &&
                typeof typeConfig === 'object' &&
                'limit' in typeConfig
            ) {
                limit = typeConfig.limit;
                ttl = typeConfig.ttl;
            }
        }

        const key = `${tracker}:${throttleType || 'default'}`;
        const { totalHits } = await this.storageService.increment(
            key,
            ttl,
            limit,
            ttl,
            'default',
        );

        if (totalHits > limit) {
            throw new ThrottlerException(
                `Rate limit exceeded for wallet: ${tracker}. Try again in ${Math.ceil(ttl / 1000)} seconds.`,
            );
        }

        return true;
    }
}
