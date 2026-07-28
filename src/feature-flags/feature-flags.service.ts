import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { FeatureFlag, FeatureFlagType } from './entities/feature-flag.entity';
import {
  CreateFeatureFlagInput,
  FeatureFlagContext,
  FeatureFlagEvaluationResult,
  FeatureFlagRuleSet,
  UpdateFeatureFlagInput,
} from './feature-flags.types';

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

    const rules: FeatureFlagRuleSet = (flag.rules as FeatureFlagRuleSet) ?? {};

    switch (flag.type) {
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

  async isEnabled(
    key: string,
    context: FeatureFlagContext = {},
  ): Promise<boolean> {
    const result = await this.evaluate(key, context);
    return result.enabled;
  }

  async findAll(environment?: string): Promise<FeatureFlag[]> {
    const env = environment ?? this.getDefaultEnvironment();
    return this.flagRepo.find({ where: { environment }, order: { key: 'ASC' } });
  }

  async findOne(id: string): Promise<FeatureFlag> {
    const flag = await this.flagRepo.findOne({ where: { id } });
    if (!flag) throw new NotFoundException(`Feature flag ${id} not found`);
    return flag;
  }

  async findByKey(key: string, environment?: string): Promise<FeatureFlag> {
    const env = environment ?? this.getDefaultEnvironment();
    const flag = await this.flagRepo.findOne({ where: { key, environment } });
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
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as FeatureFlag;
      } catch {
        // fall through to DB
      }
    }

    const flag = await this.flagRepo.findOne({ where: { key, environment } });
    if (flag) {
      await this.redisService.set(cacheKey, JSON.stringify(flag), CACHE_TTL_SECONDS);
    }
    return flag;
  }

  private async invalidateCache(key: string, environment: string): Promise<void> {
    await this.redisService.del(this.cacheKey(key, environment));
  }

  private cacheKey(key: string, environment: string): string {
    return `flag:${environment}:${key}`;
  }

  private getDefaultEnvironment(): string {
    return process.env.NODE_ENV ?? 'development';
  }
}
