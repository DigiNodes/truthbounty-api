import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { createHash } from 'crypto';

/**
 * Canonical API Cache-Key Registry
 *
 * Centralizes keys, versions, tenant/wallet scope, projection watermark,
 * TTL, and invalidation for every cached read model.
 *
 * Implements V2-BE-060: Create a Canonical API Cache-Key Registry
 */

export interface CacheKeyDefinition {
  key: string;
  version: number;
  description: string;
  ttlSeconds: number;
  scopes: CacheScope[];
  tags: string[];
  invalidationTriggers: InvalidationTrigger[];
  projectionWatermark?: string; // e.g., 'claims:v123' for projection version
  maxSizeBytes?: number; // For large cached objects
}

export type CacheScope = 'global' | 'tenant' | 'wallet' | 'user' | 'chain' | 'contract';

export interface InvalidationTrigger {
  event: string; // Event name that triggers invalidation
  pattern?: string; // Key pattern to invalidate (supports wildcards)
  tags?: string[]; // Tags to invalidate
  scope?: CacheScope; // Specific scope to invalidate
}

export interface CacheKeyTemplate {
  template: string;
  params: string[]; // Required parameters
  example: string;
}

export interface CacheStats {
  totalKeys: number;
  totalSizeBytes: number;
  hitRate: number;
  missRate: number;
  keysByScope: Record<CacheScope, number>;
  keysByTag: Record<string, number>;
  oldestKeyAge: number;
  newestKeyAge: number;
}

export interface InvalidationResult {
  invalidatedCount: number;
  invalidatedKeys: string[];
  triggers: InvalidationTrigger[];
}

/**
 * Cache Key Registry Service
 */
@Injectable()
export class CacheKeyRegistryService implements OnModuleInit {
  private readonly logger = new Logger(CacheKeyRegistryService.name);
  private readonly registry = new Map<string, CacheKeyDefinition>();
  private readonly keyTemplates = new Map<string, CacheKeyTemplate>();

  // Default TTL configurations by scope
  private readonly defaultTtlByScope: Record<CacheScope, number> = {
    global: 300,      // 5 minutes
    tenant: 600,      // 10 minutes
    wallet: 120,      // 2 minutes
    user: 120,        // 2 minutes
    chain: 600,       // 10 minutes
    contract: 300,    // 5 minutes
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerDefaultKeys();
    this.logger.log(`Cache Key Registry initialized with ${this.registry.size} definitions`);
  }

  /**
   * Register a cache key definition
   */
  registerKey(definition: CacheKeyDefinition): void {
    // Validate definition
    this.validateDefinition(definition);

    // Register key template for parameterized keys
    if (definition.key.includes('{') || definition.key.includes(':')) {
      const template = this.extractTemplate(definition.key);
      this.keyTemplates.set(definition.key, {
        template,
        params: this.extractParams(template),
        example: this.generateExample(template),
      });
    }

    this.registry.set(definition.key, definition);
    this.logger.debug(`Registered cache key: ${definition.key} (v${definition.version})`);
  }

  /**
   * Register multiple key definitions
   */
  registerKeys(definitions: CacheKeyDefinition[]): void {
    for (const def of definitions) {
      this.registerKey(def);
    }
  }

  /**
   * Build a cache key from template and parameters
   */
  buildKey(template: string, params: Record<string, string>): string {
    let key = template;
    for (const [param, value] of Object.entries(params)) {
      key = key.replace(new RegExp(`\\{${param}\\}`, 'g'), value);
    }
    return key;
  }

  /**
   * Build a namespaced cache key with version and scope
   */
  buildNamespacedKey(baseKey: string, scope: CacheScope, scopeValue?: string, version?: number): string {
    const def = this.registry.get(baseKey);
    const effectiveVersion = version || def?.version || 1;
    const scopePrefix = scopeValue ? `${scope}:${scopeValue}:` : '';
    return `cache:v${effectiveVersion}:${scopePrefix}${baseKey}`;
  }

  /**
   * Generate a full cache key with all metadata
   */
  generateCacheKey(baseKey: string, params: Record<string, string> = {}): {
    key: string;
    version: number;
    ttl: number;
    tags: string[];
  } {
    const def = this.registry.get(baseKey);
    if (!def) {
      // Fallback for unregistered keys
      const key = this.buildKey(baseKey, params);
      return {
        key: `cache:v1:auto:${key}`,
        version: 1,
        ttl: 300,
        tags: [],
      };
    }

    const key = this.buildKey(baseKey, params);
    const fullKey = `cache:v${def.version}:${def.scopes.join(':')}:${key}`;

    return {
      key: fullKey,
      version: def.version,
      ttl: def.ttlSeconds,
      tags: def.tags,
    };
  }

  /**
   * Invalidate cache entries by trigger
   */
  async invalidateByTrigger(event: string, context: Record<string, string> = {}): Promise<InvalidationResult> {
    const triggers: InvalidationTrigger[] = [];
    const invalidatedKeys: string[] = [];

    for (const [baseKey, def] of this.registry) {
      for (const trigger of def.invalidationTriggers) {
        if (trigger.event === event || trigger.event === '*') {
          triggers.push(trigger);

          let keysToInvalidate: string[] = [];

          if (trigger.pattern) {
            // Pattern-based invalidation
            const pattern = this.buildPattern(trigger.pattern, context);
            keysToInvalidate = await this.findKeysByPattern(pattern);
          } else if (trigger.tags && trigger.tags.length > 0) {
            // Tag-based invalidation
            keysToInvalidate = await this.findKeysByTags(trigger.tags);
          } else if (trigger.scope && context[trigger.scope]) {
            // Scope-based invalidation
            keysToInvalidate = await this.findKeysByScope(trigger.scope, context[trigger.scope]);
          } else {
            // Full key invalidation
            keysToInvalidate = await this.findKeysByPattern(`${baseKey}*`);
          }

          for (const key of keysToInvalidate) {
            await this.redisService.del(key);
            invalidatedKeys.push(key);
          }
        }
      }
    }

    this.logger.log(`Cache invalidation triggered by ${event}: ${invalidatedKeys.length} keys invalidated`);

    return {
      invalidatedCount: invalidatedKeys.length,
      invalidatedKeys,
      triggers,
    };
  }

  /**
   * Invalidate specific cache key
   */
  async invalidateKey(baseKey: string, params: Record<string, string> = {}): Promise<boolean> {
    const { key } = this.generateCacheKey(baseKey, params);
    const result = await this.redisService.del(key);
    return result > 0;
  }

  /**
   * Invalidate all keys for a scope value
   */
  async invalidateScope(scope: CacheScope, scopeValue: string): Promise<number> {
    const pattern = `cache:*:${scope}:${scopeValue}:*`;
    const keys = await this.findKeysByPattern(pattern);

    for (const key of keys) {
      await this.redisService.del(key);
    }

    this.logger.log(`Invalidated ${keys.length} keys for ${scope}:${scopeValue}`);
    return keys.length;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    // This would use Redis INFO and SCAN commands
    // For now, return placeholder
    return {
      totalKeys: 0,
      totalSizeBytes: 0,
      hitRate: 0,
      missRate: 0,
      keysByScope: {
        global: 0,
        tenant: 0,
        wallet: 0,
        user: 0,
        chain: 0,
        contract: 0,
      },
      keysByTag: {},
      oldestKeyAge: 0,
      newestKeyAge: 0,
    };
  }

  /**
   * Get key definition
   */
  getKeyDefinition(baseKey: string): CacheKeyDefinition | undefined {
    return this.registry.get(baseKey);
  }

  /**
   * List all registered keys
   */
  listKeys(): CacheKeyDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Export registry for documentation
   */
  exportRegistry(): string {
    const output: Record<string, any> = {};
    for (const [key, def] of this.registry) {
      output[key] = {
        version: def.version,
        description: def.description,
        ttlSeconds: def.ttlSeconds,
        scopes: def.scopes,
        tags: def.tags,
        invalidationTriggers: def.invalidationTriggers,
        projectionWatermark: def.projectionWatermark,
      };
    }
    return JSON.stringify(output, null, 2);
  }

  /**
   * Validate key definition
   */
  private validateDefinition(def: CacheKeyDefinition): void {
    if (!def.key || def.key.trim() === '') {
      throw new Error('Cache key cannot be empty');
    }
    if (def.version < 1) {
      throw new Error('Cache key version must be >= 1');
    }
    if (def.ttlSeconds < 1) {
      throw new Error('TTL must be >= 1 second');
    }
    if (!def.scopes || def.scopes.length === 0) {
      throw new Error('At least one scope must be specified');
    }
  }

  /**
   * Register default cache keys for the API
   */
  private async registerDefaultKeys(): Promise<void> {
    const defaultKeys: CacheKeyDefinition[] = [
      // Claims
      {
        key: 'claims:list:{chainId}:{status}:{page}:{limit}',
        version: 1,
        description: 'Paginated claim list filtered by chain and status',
        ttlSeconds: 60,
        scopes: ['chain', 'wallet'],
        tags: ['claims', 'list'],
        invalidationTriggers: [
          { event: 'claim.created', pattern: 'claims:list:*' },
          { event: 'claim.updated', pattern: 'claims:list:*' },
          { event: 'claim.deleted', pattern: 'claims:list:*' },
        ],
      },
      {
        key: 'claims:detail:{claimId}',
        version: 1,
        description: 'Single claim detail with evidence and disputes',
        ttlSeconds: 120,
        scopes: ['wallet'],
        tags: ['claims', 'detail'],
        invalidationTriggers: [
          { event: 'claim.updated', pattern: 'claims:detail:*' },
          { event: 'claim.deleted', pattern: 'claims:detail:*' },
          { event: 'evidence.added', pattern: 'claims:detail:*' },
          { event: 'dispute.created', pattern: 'claims:detail:*' },
        ],
      },
      {
        key: 'claims:feed:{walletAddress}:{cursor}:{limit}',
        version: 1,
        description: 'User-specific claim feed with cursor pagination',
        ttlSeconds: 60,
        scopes: ['wallet'],
        tags: ['claims', 'feed'],
        invalidationTriggers: [
          { event: 'claim.created', pattern: 'claims:feed:*' },
          { event: 'claim.updated', pattern: 'claims:feed:*' },
        ],
      },

      // Disputes
      {
        key: 'disputes:list:{chainId}:{status}:{page}:{limit}',
        version: 1,
        description: 'Paginated dispute list',
        ttlSeconds: 60,
        scopes: ['chain', 'wallet'],
        tags: ['disputes', 'list'],
        invalidationTriggers: [
          { event: 'dispute.created', pattern: 'disputes:list:*' },
          { event: 'dispute.updated', pattern: 'disputes:list:*' },
          { event: 'dispute.resolved', pattern: 'disputes:list:*' },
        ],
      },
      {
        key: 'disputes:detail:{disputeId}',
        version: 1,
        description: 'Single dispute detail with votes and evidence',
        ttlSeconds: 120,
        scopes: ['wallet'],
        tags: ['disputes', 'detail'],
        invalidationTriggers: [
          { event: 'dispute.updated', pattern: 'disputes:detail:*' },
          { event: 'vote.cast', pattern: 'disputes:detail:*' },
        ],
      },

      // User/Wallet
      {
        key: 'identity:profile:{walletAddress}',
        version: 1,
        description: 'User profile with linked wallets and reputation',
        ttlSeconds: 300,
        scopes: ['wallet'],
        tags: ['identity', 'profile'],
        invalidationTriggers: [
          { event: 'wallet.linked', pattern: 'identity:profile:*' },
          { event: 'wallet.unlinked', pattern: 'identity:profile:*' },
          { event: 'reputation.updated', pattern: 'identity:profile:*' },
        ],
      },
      {
        key: 'identity:wallets:{walletAddress}',
        version: 1,
        description: 'Linked wallets for a user',
        ttlSeconds: 600,
        scopes: ['wallet'],
        tags: ['identity', 'wallets'],
        invalidationTriggers: [
          { event: 'wallet.linked', pattern: 'identity:wallets:*' },
          { event: 'wallet.unlinked', pattern: 'identity:wallets:*' },
        ],
      },
      {
        key: 'reputation:score:{walletAddress}',
        version: 1,
        description: 'Sybil resistance score for wallet',
        ttlSeconds: 3600,
        scopes: ['wallet'],
        tags: ['reputation', 'score'],
        invalidationTriggers: [
          { event: 'reputation.updated', pattern: 'reputation:score:*' },
        ],
      },

      // Blockchain/Indexer
      {
        key: 'indexer:cursor:{chainId}:{contractAddress}',
        version: 1,
        description: 'Indexer cursor position for contract',
        ttlSeconds: 86400, // 24 hours
        scopes: ['chain', 'contract'],
        tags: ['indexer', 'cursor'],
        invalidationTriggers: [
          { event: 'indexer.checkpoint', pattern: 'indexer:cursor:*' },
        ],
      },
      {
        key: 'blockchain:block:{chainId}:{blockNumber}',
        version: 1,
        description: 'Cached block data',
        ttlSeconds: 3600,
        scopes: ['chain'],
        tags: ['blockchain', 'block'],
      },
      {
        key: 'blockchain:events:{chainId}:{contractAddress}:{fromBlock}:{toBlock}',
        version: 1,
        description: 'Cached contract events for block range',
        ttlSeconds: 300,
        scopes: ['chain', 'contract'],
        tags: ['blockchain', 'events'],
        invalidationTriggers: [
          { event: 'indexer.reorg', pattern: 'blockchain:events:*' },
        ],
      },

      // Rewards
      {
        key: 'rewards:balance:{walletAddress}:{tokenAddress}',
        version: 1,
        description: 'Reward balance for wallet and token',
        ttlSeconds: 60,
        scopes: ['wallet', 'contract'],
        tags: ['rewards', 'balance'],
        invalidationTriggers: [
          { event: 'rewards.claimed', pattern: 'rewards:balance:*' },
          { event: 'rewards.distributed', pattern: 'rewards:balance:*' },
        ],
      },
      {
        key: 'rewards:history:{walletAddress}:{cursor}:{limit}',
        version: 1,
        description: 'Reward claim history with pagination',
        ttlSeconds: 120,
        scopes: ['wallet'],
        tags: ['rewards', 'history'],
        invalidationTriggers: [
          { event: 'rewards.claimed', pattern: 'rewards:history:*' },
        ],
      },

      // Leaderboard
      {
        key: 'leaderboard:{chainId}:{metric}:{period}:{page}:{limit}',
        version: 1,
        description: 'Leaderboard rankings',
        ttlSeconds: 300,
        scopes: ['chain'],
        tags: ['leaderboard', 'rankings'],
        invalidationTriggers: [
          { event: 'reputation.updated', pattern: 'leaderboard:*' },
          { event: 'rewards.distributed', pattern: 'leaderboard:*' },
        ],
      },

      // Config
      {
        key: 'config:feature-flags',
        version: 1,
        description: 'Feature flag configuration',
        ttlSeconds: 60,
        scopes: ['global'],
        tags: ['config', 'feature-flags'],
        invalidationTriggers: [
          { event: 'config.updated', tags: ['config'] },
        ],
      },
      {
        key: 'config:contract-addresses:{chainId}',
        version: 1,
        description: 'Contract addresses for chain',
        ttlSeconds: 3600,
        scopes: ['chain'],
        tags: ['config', 'contracts'],
        invalidationTriggers: [
          { event: 'contract.deployed', pattern: 'config:contract-addresses:*' },
        ],
      },

      // Analytics
      {
        key: 'analytics:metrics:{chainId}:{metric}:{interval}',
        version: 1,
        description: 'Aggregated metrics',
        ttlSeconds: 300,
        scopes: ['chain'],
        tags: ['analytics', 'metrics'],
      },
      {
        key: 'analytics:events:{chainId}:{eventType}:{fromBlock}:{toBlock}',
        version: 1,
        description: 'Event analytics',
        ttlSeconds: 600,
        scopes: ['chain'],
        tags: ['analytics', 'events'],
      },

      // Search
      {
        key: 'search:claims:{queryHash}:{filters}:{page}:{limit}',
        version: 1,
        description: 'Claim search results',
        ttlSeconds: 120,
        scopes: ['global'],
        tags: ['search', 'claims'],
        invalidationTriggers: [
          { event: 'claim.created', pattern: 'search:claims:*' },
          { event: 'claim.updated', pattern: 'search:claims:*' },
        ],
      },
    ];

    this.registerKeys(defaultKeys);
  }

  /**
   * Extract template from key pattern
   */
  private extractTemplate(key: string): string {
    // Convert {param} placeholders to template
    return key;
  }

  /**
   * Extract parameter names from template
   */
  private extractParams(template: string): string[] {
    const matches = template.match(/\{([^}]+)\}/g);
    return matches ? matches.map(m => m.slice(1, -1)) : [];
  }

  /**
   * Generate example key from template
   */
  private generateExample(template: string): string {
    return template.replace(/\{([^}]+)\}/g, (_, param) => `example-${param}`);
  }

  /**
   * Build pattern for invalidation
   */
  private buildPattern(pattern: string, context: Record<string, string>): string {
    let result = pattern;
    for (const [key, value] of Object.entries(context)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result.replace(/\{[^}]+\}/g, '*');
  }

  /**
   * Find keys by pattern (placeholder - uses SCAN in production)
   */
  private async findKeysByPattern(pattern: string): Promise<string[]> {
    // In production, use Redis SCAN command
    // For now, return empty array
    return [];
  }

  /**
   * Find keys by tags
   */
  private async findKeysByTags(tags: string[]): Promise<string[]> {
    // In production, maintain tag-to-keys index
    return [];
  }

  /**
   * Find keys by scope
   */
  private async findKeysByScope(scope: CacheScope, scopeValue: string): Promise<string[]> {
    const pattern = `cache:*:${scope}:${scopeValue}:*`;
    return this.findKeysByPattern(pattern);
  }
}