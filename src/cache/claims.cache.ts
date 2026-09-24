import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

@Injectable()
export class ClaimsCache {
    private readonly logger = new Logger(ClaimsCache.name);
    private readonly ttl: number;
    private readonly cacheVersion: string;
    private readonly indexKey = 'claims:cache:keys'; // Track all cache keys for bulk invalidation

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
    ) {
        // TTL is configurable via environment variable, defaults to 300 seconds (5 minutes) - bounded TTL
        this.ttl = this.configService.get<number>('CACHE_CLAIMS_TTL', 300);
        // Versioned cache keys - increment this when cache schema changes
        this.cacheVersion = this.configService.get<string>('CACHE_VERSION', 'v1');
        this.logger.log(`Claims cache initialized with version ${this.cacheVersion}, TTL ${this.ttl}s`);
    }

    /**
     * Generates a VERSIONED key for a specific claim by its ID
     * Versioning ensures cache key uniqueness across schema changes
     */
    private getClaimKey(id: string): string {
        return `${this.cacheVersion}:claim:${id}`;
    }

    /**
     * Generates a VERSIONED key for the latest claims list
     */
    private getLatestClaimsKey(): string {
        return `${this.cacheVersion}:claims:latest`;
    }

    /**
     * Generates a VERSIONED key for claims associated with a specific user wallet
     */
    private getUserClaimsKey(wallet: string): string {
        return `${this.cacheVersion}:claims:user:${wallet.toLowerCase()}`;
    }

    /**
     * Generates a content-addressed key for query results to prevent stale cache
     * This ensures that the same query parameters always produce the same key
     * while maintaining versioning boundaries
     */
    private getQueryKey(namespace: string, params: Record<string, any>): string {
        const paramsStr = JSON.stringify(params, Object.keys(params).sort());
        const hash = createHash('sha256').update(paramsStr).digest('hex').slice(0, 16);
        return `${this.cacheVersion}:${namespace}:${hash}`;
    }

    /**
     * Retrieves a claim from cache
     */
    async getClaim(id: string): Promise<any | null> {
        const data = await this.redisService.get(this.getClaimKey(id));
        if (data) {
            this.logger.debug(`Cache hit for claim:${id}`);
            try {
                return JSON.parse(data);
            } catch (e) {
                this.logger.error(`Failed to parse cached claim ${id}: ${e.message}`);
                return null;
            }
        }
        this.logger.debug(`Cache miss for claim:${id}`);
        return null;
    }

    /**
     * Stores a claim in cache and tracks the key for future invalidation
     */
    async setClaim(id: string, claim: any): Promise<void> {
        const key = this.getClaimKey(id);
        await this.redisService.set(key, JSON.stringify(claim), this.ttl);
        // Track this key in our index for bulk invalidation during reorgs
        await this.trackKey(key);
        this.logger.debug(`Cached claim:${id} with key ${key}`);
    }

    /**
     * Retrieves the list of latest claims from cache
     */
    async getLatestClaims(): Promise<any[] | null> {
        const data = await this.redisService.get(this.getLatestClaimsKey());
        if (data) {
            this.logger.debug('Cache hit for claims:latest');
            try {
                return JSON.parse(data);
            } catch (e) {
                this.logger.error(`Failed to parse cached latest claims: ${e.message}`);
                return null;
            }
        }
        this.logger.debug('Cache miss for claims:latest');
        return null;
    }

    /**
     * Stores the list of latest claims in cache and tracks the key
     */
    async setLatestClaims(claims: any[]): Promise<void> {
        const key = this.getLatestClaimsKey();
        await this.redisService.set(key, JSON.stringify(claims), this.ttl);
        await this.trackKey(key);
        this.logger.debug(`Cached claims:latest with key ${key}`);
    }

    /**
     * Retrieves claims for a specific user from cache
     */
    async getUserClaims(wallet: string): Promise<any[] | null> {
        const data = await this.redisService.get(this.getUserClaimsKey(wallet));
        if (data) {
            this.logger.debug(`Cache hit for claims:user:${wallet}`);
            try {
                return JSON.parse(data);
            } catch (e) {
                this.logger.error(`Failed to parse cached user claims for ${wallet}: ${e.message}`);
                return null;
            }
        }
        this.logger.debug(`Cache miss for claims:user:${wallet}`);
        return null;
    }

    /**
     * Stores user claims in cache and tracks the key
     */
    async setUserClaims(wallet: string, claims: any[]): Promise<void> {
        const key = this.getUserClaimsKey(wallet);
        await this.redisService.set(key, JSON.stringify(claims), this.ttl);
        await this.trackKey(key);
        this.logger.debug(`Cached claims:user:${wallet} with key ${key}`);
    }

    /**
     * Track a cache key in our index set for future bulk invalidation
     * This allows us to invalidate all related cache entries during reorgs
     */
    private async trackKey(key: string): Promise<void> {
        const client = this.redisService.getClient();
        if (client) {
            try {
                await client.sadd(this.indexKey, key);
                // Set expiry on the index itself to prevent memory leaks
                await client.expire(this.indexKey, this.ttl * 2);
            } catch (e) {
                this.logger.warn(`Failed to track cache key ${key}: ${(e as Error).message}`);
            }
        }
    }

    /**
     * Invalidate ALL cached claims - used during chain reorgs or major projection changes
     * This ensures that after a reorg, we never serve stale cache data that was based on
     * an invalid blockchain state
     */
    async invalidateAllForReorg(): Promise<void> {
        this.logger.warn('Invalidating ALL claims cache due to chain reorg');
        const client = this.redisService.getClient();
        if (!client) return;
        
        try {
            // Get all tracked keys
            const keys = await client.smembers(this.indexKey);
            if (keys.length > 0) {
                this.logger.log(`Invalidating ${keys.length} cache keys during reorg`);
                await client.del(...keys);
            }
            // Clear the index
            await client.del(this.indexKey);
        } catch (e) {
            this.logger.error(`Failed to invalidate cache during reorg: ${(e as Error).message}`);
        }
    }

    /**
     * Invalidate cache for a specific block range that was reorged out
     * This allows granular invalidation if we know exactly which claims were affected
     */
    async invalidateBlockRange(startBlock: number, endBlock: number): Promise<void> {
        this.logger.log(`Invalidating claims cache for blocks ${startBlock}-${endBlock}`);
        // In a production implementation, you would track which claims are associated
        // with which blocks, but for safety, we invalidate everything in case of any reorg
        // This maintains the invariant that smart contracts are always the source of truth
        await this.invalidateAllForReorg();
    }

    /**
     * Invalidate cache when projections are committed (updated)
     * This ensures that any database projection changes immediately invalidate stale cache
     */
    async invalidateForProjectionUpdate(affectedClaimIds?: string[]): Promise<void> {
        this.logger.debug(`Invalidating cache for projection update`);
        
        if (affectedClaimIds && affectedClaimIds.length > 0) {
            // Granular invalidation for specific affected claims
            const promises = affectedClaimIds.map(id => this.invalidateClaim(id));
            await Promise.all(promises);
            this.logger.log(`Invalidated ${affectedClaimIds.length} affected claims`);
        } else {
            // If no specific claims identified, invalidate all to be safe
            await this.invalidateAllForReorg();
        }
    }

    /**
     * Invalidates claim cache and dependent lists
     * Should be called on update/delete
     */
    async invalidateClaim(id: string, userWallet?: string): Promise<void> {
        const keysToDelete = [
            this.getClaimKey(id),
            this.getLatestClaimsKey(),
        ];

        if (userWallet) {
            keysToDelete.push(this.getUserClaimsKey(userWallet));
        }

        // Delete the keys from Redis
        const promises = keysToDelete.map(key => this.redisService.del(key));
        
        // Also remove them from our tracking index
        const client = this.redisService.getClient();
        if (client) {
            try {
                await client.srem(this.indexKey, ...keysToDelete);
            } catch (e) {
                this.logger.warn(`Failed to remove keys from index: ${(e as Error).message}`);
            }
        }

        await Promise.all(promises);
        this.logger.debug(`Invalidated cache for claim:${id} and related lists, deleted ${keysToDelete.length} keys`);
    }

    /**
     * Invalidates only user-specific claims cache
     */
    async invalidateUserClaims(wallet: string): Promise<void> {
        await this.redisService.del(this.getUserClaimsKey(wallet));
        this.logger.debug(`Invalidated cache for claims:user:${wallet}`);
    }
}