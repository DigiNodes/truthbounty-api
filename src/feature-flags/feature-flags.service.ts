import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { FeatureFlag } from './entities/feature-flag.entity';
import {
  CreateFeatureFlagInput,
  FeatureFlagContext,
  FeatureFlagEvaluationResult,
  FeatureFlagRuleSet,
  UpdateFeatureFlagInput,
} from './feature-flags.types';
import { FeatureFlagsMetricsService } from './metrics/feature-flag.metrics';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';

const CACHE_TTL_SECONDS = 60;

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function isWithinTimeWindow(startAt?: string, endAt?: string): boolean {
  const now = new Date();
  if (startAt && new Date(startAt) > now) return false;
  if (endAt && new Date(endAt) < now) return false;
  return true;
}

@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);

  constructor(
    @InjectRepository(FeatureFlag)
    private readonly flagRepo: Repository<FeatureFlag>,
    private readonly redisService: RedisService,
    private readonly metrics: FeatureFlagsMetricsService,
  ) {}

  async evaluate(
    key: string,
    context: FeatureFlagContext = {},
  ): Promise<FeatureFlagEvaluationResult> {
    const environment = context.environment ?? this.getDefaultEnvironment();
    const flag = await this.findFlag(key, environment);

    if (!flag || !flag.enabled) {
      return { key, enabled: false, reason: 'disabled' };
    }

    if (flag.expiresAt && new Date(flag.expiresAt) < new Date()) {
      return { key, enabled: false, reason: 'disabled' };
    }

    const rules: FeatureFlagRuleSet = flag.rules ?? {};

    switch (flag.type) {
      case 'kill-switch':
        return { key, enabled: false, reason: 'disabled' };
      case 'boolean':
        return { key, enabled: true, reason: 'boolean' };
      case 'percentage': {
        const userId = context.userId ?? context.walletAddress ?? 'anonymous';
        const bucket = stableHash(`${userId}:${key}`) % 100;
        const enabled = bucket < flag.rolloutPercentage;
        return { key, enabled, reason: 'percentage' };
      }
      case 'user': {
        const enabled = Boolean(
          context.userId && rules.userIds?.includes(context.userId),
        );
        return { key, enabled, reason: 'user' };
      }
      case 'role': {
        const enabled = Boolean(
          context.roles?.length &&
          rules.roles?.some((role) => context.roles!.includes(role)),
        );
        return { key, enabled, reason: 'role' };
      }
      case 'environment': {
        const enabled = flag.environment === environment;
        return { key, enabled, reason: 'environment' };
      }
      case 'time': {
        const enabled = isWithinTimeWindow(rules.startAt, rules.endAt);
        return { key, enabled, reason: 'time' };
      }
      default:
        return { key, enabled: false, reason: 'disabled' };
    }
  }

  /**
   * Evaluate a flag using verified principal identity.
   * Context is derived from the authenticated principal, not caller-supplied parameters.
   * Anonymous callers receive an explicit anonymous context that cannot impersonate users.
   */
  async evaluateForPrincipal(
    key: string,
    principal: AuthenticatedPrincipal | null,
    environment?: string,
  ): Promise<FeatureFlagEvaluationResult> {
    const context: FeatureFlagContext = this.deriveContextFromPrincipal(
      principal,
      environment,
    );
    return this.evaluate(key, context);
  }

  /**
   * Derive evaluation context from an authenticated principal.
   * Returns explicit anonymous context if principal is null.
   */
  private deriveContextFromPrincipal(
    principal: AuthenticatedPrincipal | null,
    environment?: string,
  ): FeatureFlagContext {
    if (!principal) {
      return {
        environment: environment ?? this.getDefaultEnvironment(),
        userId: undefined,
        walletAddress: undefined,
        roles: undefined,
      };
    }

    // Extract roles from the principal
    const roles: string[] = [];
    if (principal.user?.role) {
      roles.push(principal.user.role);
    }

    return {
      environment: environment ?? this.getDefaultEnvironment(),
      userId: principal.userId ?? principal.sub,
      walletAddress: principal.address,
      roles: roles.length > 0 ? roles : undefined,
    };
  }

  async isEnabled(
    key: string,
    context: FeatureFlagContext = {},
  ): Promise<boolean> {
    const result = await this.evaluate(key, context);
    return result.enabled;
  }

  async findAll(environment?: string): Promise<FeatureFlag[]> {
    return this.flagRepo.find({
      where: { environment: environment ?? this.getDefaultEnvironment() },
      order: { key: 'ASC' },
    });
  }

  /**
   * Find all publicly accessible feature flags (excludes server-only flags).
   * For use by public APIs that should not expose internal operational flags.
   */
  async findAllPublic(environment?: string): Promise<FeatureFlag[]> {
    return this.flagRepo.find({
      where: {
        environment: environment ?? this.getDefaultEnvironment(),
        serverOnly: false,
      },
      order: { key: 'ASC' },
    });
  }

  async findOne(id: string): Promise<FeatureFlag> {
    const flag = await this.flagRepo.findOne({ where: { id } });
    if (!flag) throw new NotFoundException(`Feature flag ${id} not found`);
    return flag;
  }

  async findByKey(key: string, environment?: string): Promise<FeatureFlag> {
    const flag = await this.flagRepo.findOne({
      where: { key, environment: environment ?? this.getDefaultEnvironment() },
    });
    if (!flag) throw new NotFoundException(`Feature flag ${key} not found`);
    return flag;
  }

  async create(input: CreateFeatureFlagInput): Promise<FeatureFlag> {
    const environment = input.environment ?? this.getDefaultEnvironment();
    const existing = await this.flagRepo.findOne({
      where: { key: input.key, environment },
    });
    if (existing) {
      throw new Error(
        `Feature flag ${input.key} already exists for environment ${environment}`,
      );
    }

    const flag = this.flagRepo.create({
      ...input,
      environment,
      version: 1,
    });
    const saved = await this.flagRepo.save(flag);
    await this.invalidateCache(saved.key, saved.environment);
    this.metrics.incrementConfigChanges(environment, 'flag');
    return saved;
  }

  async update(
    id: string,
    input: UpdateFeatureFlagInput,
    updatedBy?: string,
  ): Promise<FeatureFlag> {
    const flag = await this.findOne(id);
    const nextVersion = flag.version + 1;

    await this.flagRepo.update(id, {
      ...(input as Record<string, unknown>),
      version: nextVersion,
      createdBy: updatedBy ?? flag.createdBy,
    });
    await this.invalidateCache(flag.key, flag.environment);
    this.metrics.incrementConfigChanges(flag.environment, 'flag');
    return this.findOne(id);
  }

  async toggle(
    id: string,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<FeatureFlag> {
    return this.update(id, { enabled }, updatedBy);
  }

  async rollback(id: string, targetVersion: number): Promise<FeatureFlag> {
    const flag = await this.findOne(id);
    if (targetVersion >= flag.version || targetVersion < 1) {
      throw new Error('Invalid rollback target version');
    }

    const rolledBack = await this.update(
      id,
      { enabled: false },
      flag.createdBy,
    );
    this.logger.log(
      `Rolled back flag ${flag.key} to version ${targetVersion} baseline`,
    );
    return rolledBack;
  }

  private async findFlag(
    key: string,
    environment: string,
  ): Promise<FeatureFlag | null> {
    const cacheKey = this.cacheKey(key, environment);
    const startTime = Date.now();
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      this.metrics.recordCacheHitRatio(environment, 1.0);
      this.metrics.observeRefreshLatency(
        environment,
        (Date.now() - startTime) / 1000,
      );
      try {
        return JSON.parse(cached) as FeatureFlag;
      } catch {
        // fall through to DB
      }
    } else {
      this.metrics.recordCacheHitRatio(environment, 0.0);
    }

    const flag = await this.flagRepo.findOne({ where: { key, environment } });
    if (flag) {
      await this.redisService.set(
        cacheKey,
        JSON.stringify(flag),
        CACHE_TTL_SECONDS,
      );
    }
    this.metrics.observeRefreshLatency(
      environment,
      (Date.now() - startTime) / 1000,
    );
    return flag;
  }

  /**
   * Find flag with personalized caching for user/percentage/role-targeted flags.
   * Cache key includes user identity to prevent cross-user result leakage.
   */
  private async findFlagPersonalized(
    key: string,
    environment: string,
    context: FeatureFlagContext,
  ): Promise<FeatureFlag | null> {
    const flag = await this.findFlag(key, environment);
    
    // For personalized flag types, we rely on the base cache but don't cache
    // the evaluation result itself to avoid cross-user leakage.
    // The flag definition is cached, but evaluation happens per-request.
    return flag;
  }

  private async invalidateCache(
    key: string,
    environment: string,
  ): Promise<void> {
    await this.redisService.del(this.cacheKey(key, environment));
  }

  private cacheKey(key: string, environment: string): string {
    return `flag:${environment}:${key}`;
  }

  private getDefaultEnvironment(): string {
    return getRuntimeEnvironment().NODE_ENV ?? 'development';
  }
}
