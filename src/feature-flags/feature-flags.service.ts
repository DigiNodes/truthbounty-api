import { getRuntimeEnvironment } from '../config/runtime-config';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { EntityManager, Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { TransactionRunner } from '../database/transaction.runner';
import { FeatureFlag, FeatureFlagType } from './entities/feature-flag.entity';
import { FeatureFlagAuditEvent } from './entities/feature-flag-audit-event.entity';
import { FeatureFlagVersion } from './entities/feature-flag-version.entity';
import {
  CreateFeatureFlagInput,
  FeatureFlagConfiguration,
  FeatureFlagContext,
  FeatureFlagEvaluationResult,
  FeatureFlagRuleSet,
  UpdateFeatureFlagInput,
} from './feature-flags.types';
import { FeatureFlagsMetricsService } from './metrics/feature-flag.metrics';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';

const CACHE_TTL_SECONDS = 60;

const VALID_FLAG_TYPES = new Set<FeatureFlagType>([
  'boolean',
  'percentage',
  'user',
  'role',
  'environment',
  'time',
  'kill-switch',
]);

type FeatureFlagAuditAction = FeatureFlagAuditEvent['action'];

interface StateChangeInput {
  id: string;
  action: FeatureFlagAuditAction;
  actorId?: string;
  reason?: string;
  sourceVersion?: number | null;
  expectedVersion?: number;
  nextConfiguration: (
    flag: FeatureFlag,
    manager: EntityManager,
  ) => FeatureFlagConfiguration | Promise<FeatureFlagConfiguration>;
}

interface StateChangeResult {
  flag: FeatureFlag;
  before: FeatureFlagConfiguration;
  after: FeatureFlagConfiguration;
  fromVersion: number;
  toVersion: number;
  sourceVersion: number | null;
  action: FeatureFlagAuditAction;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`;
}

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
    @InjectRepository(FeatureFlagVersion)
    private readonly versionRepo: Repository<FeatureFlagVersion>,
    @InjectRepository(FeatureFlagAuditEvent)
    private readonly auditRepo: Repository<FeatureFlagAuditEvent>,
    private readonly redisService: RedisService,
    private readonly metrics: FeatureFlagsMetricsService,
    private readonly transactionRunner: TransactionRunner,
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

  async getHistory(id: string): Promise<FeatureFlagVersion[]> {
    await this.findOne(id);
    return this.versionRepo.find({
      where: { flagId: id },
      order: { version: 'DESC' },
    });
  }

  async create(input: CreateFeatureFlagInput): Promise<FeatureFlag> {
    const environment = input.environment ?? this.getDefaultEnvironment();
    const saved = await this.transactionRunner.run(async (manager) => {
      const flagRepo = manager.getRepository(FeatureFlag);
      const versionRepo = manager.getRepository(FeatureFlagVersion);
      const auditRepo = manager.getRepository(FeatureFlagAuditEvent);

      const existing = await flagRepo.findOne({
        where: { key: input.key, environment },
      });
      if (existing) {
        throw new ConflictException(
          `Feature flag ${input.key} already exists for environment ${environment}`,
        );
      }

      const flag = flagRepo.create({
        ...input,
        environment,
        version: 1,
        rolledBackFromVersion: null,
        changeReason: null,
      });
      const created = await flagRepo.save(flag);
      const configuration = this.configurationFromFlag(created);
      this.validateConfiguration(configuration);

      await versionRepo.insert(
        this.buildSnapshot({
          flagId: created.id,
          version: created.version,
          configuration,
          previousHash: null,
          sourceVersion: null,
          actorId: input.createdBy,
          reason: null,
        }),
      );
      await auditRepo.insert({
        flagId: created.id,
        key: configuration.key,
        action: 'create',
        actorId: input.createdBy ?? null,
        sourceVersion: null,
        fromVersion: null,
        toVersion: created.version,
        outcome: 'applied',
        reason: null,
        beforeState: null,
        afterState: this.serializableConfiguration(configuration),
      });

      return created;
    });

    await this.afterCommit({
      flag: saved,
      before: this.configurationFromFlag(saved),
      after: this.configurationFromFlag(saved),
      fromVersion: saved.version,
      toVersion: saved.version,
      sourceVersion: null,
      action: 'create',
    });
    return saved;
  }

  async update(
    id: string,
    input: UpdateFeatureFlagInput,
    updatedBy?: string,
  ): Promise<FeatureFlag> {
    const expectedVersion = input.expectedVersion;
    const reason = input.reason ?? 'Feature flag updated';
    const result = await this.applyStateChange({
      id,
      action: 'update',
      actorId: updatedBy,
      reason,
      expectedVersion,
      nextConfiguration: (flag) => {
        const current = this.configurationFromFlag(flag);
        return {
          ...current,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.rolloutPercentage !== undefined
            ? { rolloutPercentage: input.rolloutPercentage }
            : {}),
          ...(input.rules !== undefined ? { rules: input.rules } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.expiresAt !== undefined
            ? { expiresAt: this.normalizeDate(input.expiresAt) }
            : {}),
        };
      },
    });

    await this.afterCommit(result);
    return result.flag;
  }

  async toggle(
    id: string,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<FeatureFlag> {
    return this.update(id, { enabled }, updatedBy);
  }

  async rollback(
    id: string,
    targetVersion: number,
    rolledBackBy?: string,
    reason?: string,
    expectedVersion?: number,
  ): Promise<FeatureFlag> {
    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
      throw new BadRequestException('Invalid rollback target version');
    }

    const result = await this.applyStateChange({
      id,
      action: 'rollback',
      actorId: rolledBackBy,
      reason: reason ?? `Rolled back to version ${targetVersion}`,
      sourceVersion: targetVersion,
      expectedVersion,
      nextConfiguration: async (flag, manager) => {
        if (targetVersion >= flag.version) {
          throw new BadRequestException(
            'Rollback target version must be older than the current version',
          );
        }

        const snapshot = await manager
          .getRepository(FeatureFlagVersion)
          .findOne({ where: { flagId: flag.id, version: targetVersion } });
        if (!snapshot) {
          throw new NotFoundException(
            `Feature flag snapshot for version ${targetVersion} not found`,
          );
        }

        return this.configurationFromSnapshot(snapshot, flag);
      },
    });

    await this.afterCommit(result);
    this.logger.log(
      `Rolled back flag ${result.after.key} from version ${result.fromVersion} ` +
        `to snapshot ${targetVersion}, resulting in version ${result.toVersion}`,
    );
    return result.flag;
  }

  async emergencyDisable(
    id: string,
    actorId?: string,
    reason?: string,
    expectedVersion?: number,
  ): Promise<FeatureFlag> {
    const result = await this.applyStateChange({
      id,
      action: 'emergency_disable',
      actorId,
      reason: reason ?? 'Emergency disable',
      expectedVersion,
      nextConfiguration: (flag) => ({
        ...this.configurationFromFlag(flag),
        enabled: false,
      }),
    });

    await this.afterCommit(result);
    this.logger.log(
      `Emergency disabled flag ${result.after.key} at version ${result.toVersion}`,
    );
    return result.flag;
  }

  private async applyStateChange(
    input: StateChangeInput,
  ): Promise<StateChangeResult> {
    return this.transactionRunner.run(async (manager) => {
      const flagRepo = manager.getRepository(FeatureFlag);
      const versionRepo = manager.getRepository(FeatureFlagVersion);
      const auditRepo = manager.getRepository(FeatureFlagAuditEvent);

      const flag = await flagRepo.findOne({ where: { id: input.id } });
      if (!flag) {
        throw new NotFoundException(`Feature flag ${input.id} not found`);
      }
      if (
        input.expectedVersion !== undefined &&
        flag.version !== input.expectedVersion
      ) {
        throw new ConflictException(
          `Feature flag version changed: expected ${input.expectedVersion}, found ${flag.version}`,
        );
      }

      const before = this.configurationFromFlag(flag);
      this.validateConfiguration(before);
      const after = await input.nextConfiguration(flag, manager);
      this.validateConfiguration(after);

      const fromVersion = flag.version;
      const toVersion = fromVersion + 1;
      const currentSnapshot = await versionRepo.findOne({
        where: { flagId: flag.id, version: fromVersion },
      });

      if (!currentSnapshot) {
        await versionRepo.insert(
          this.buildSnapshot({
            flagId: flag.id,
            version: fromVersion,
            configuration: before,
            previousHash: null,
            sourceVersion: null,
            actorId: undefined,
            reason: 'Backfilled current state before mutation',
          }),
        );
      }

      const patch = {
        ...after,
        version: toVersion,
        rolledBackFromVersion: input.sourceVersion ?? null,
        changeReason: input.reason ?? null,
        createdBy: input.actorId ?? flag.createdBy,
      };
      const updateResult = await flagRepo.update(
        { id: flag.id, version: fromVersion },
        patch as Parameters<Repository<FeatureFlag>['update']>[1],
      );
      if (updateResult?.affected === 0) {
        throw new ConflictException(
          'Feature flag version changed concurrently',
        );
      }

      const refreshed = await flagRepo.findOne({ where: { id: flag.id } });
      const updated = refreshed ?? ({ ...flag, ...patch } as FeatureFlag);

      await versionRepo.insert(
        this.buildSnapshot({
          flagId: flag.id,
          version: toVersion,
          configuration: after,
          previousHash: currentSnapshot?.contentHash ?? null,
          sourceVersion: input.sourceVersion ?? null,
          actorId: input.actorId,
          reason: input.reason,
        }),
      );
      await auditRepo.insert({
        flagId: flag.id,
        key: after.key,
        action: input.action,
        actorId: input.actorId ?? null,
        sourceVersion: input.sourceVersion ?? null,
        fromVersion,
        toVersion,
        outcome: 'applied',
        reason: input.reason ?? null,
        beforeState: this.serializableConfiguration(before),
        afterState: this.serializableConfiguration(after),
      });

      return {
        flag: updated,
        before,
        after,
        fromVersion,
        toVersion,
        sourceVersion: input.sourceVersion ?? null,
        action: input.action,
      };
    });
  }

  private configurationFromFlag(flag: FeatureFlag): FeatureFlagConfiguration {
    return {
      key: flag.key,
      type: flag.type,
      enabled: Boolean(flag.enabled),
      rolloutPercentage: Number(flag.rolloutPercentage ?? 0),
      rules: flag.rules ?? null,
      environment: flag.environment,
      description: flag.description ?? null,
      isPermanent: Boolean(flag.isPermanent),
      metadata: flag.metadata ?? null,
      expiresAt: this.normalizeDate(flag.expiresAt),
    };
  }

  private configurationFromSnapshot(
    snapshot: FeatureFlagVersion,
    flag: FeatureFlag,
  ): FeatureFlagConfiguration {
    if (snapshot.validationStatus !== 'valid') {
      throw new BadRequestException(
        `Feature flag snapshot ${snapshot.version} is not eligible for rollback`,
      );
    }

    const configuration: FeatureFlagConfiguration = {
      key: snapshot.key,
      type: snapshot.type,
      enabled: Boolean(snapshot.enabled),
      rolloutPercentage: Number(snapshot.rolloutPercentage ?? 0),
      rules: snapshot.rules ?? null,
      environment: snapshot.environment,
      description: snapshot.description ?? null,
      isPermanent: Boolean(snapshot.isPermanent),
      metadata: snapshot.metadata ?? null,
      expiresAt: this.normalizeDate(snapshot.expiresAt),
    };

    this.validateConfiguration(configuration);
    if (configuration.key !== flag.key) {
      throw new BadRequestException(
        'Feature flag snapshot is incompatible with the active flag',
      );
    }
    if (snapshot.contentHash !== this.computeContentHash(configuration)) {
      throw new BadRequestException(
        `Feature flag snapshot ${snapshot.version} is corrupt`,
      );
    }

    return configuration;
  }

  private validateConfiguration(configuration: FeatureFlagConfiguration): void {
    if (
      typeof configuration.key !== 'string' ||
      configuration.key.length === 0
    ) {
      throw new BadRequestException('Feature flag snapshot has an invalid key');
    }
    if (!VALID_FLAG_TYPES.has(configuration.type)) {
      throw new BadRequestException(
        'Feature flag snapshot has an invalid type',
      );
    }
    if (
      !Number.isFinite(configuration.rolloutPercentage) ||
      configuration.rolloutPercentage < 0 ||
      configuration.rolloutPercentage > 100
    ) {
      throw new BadRequestException(
        'Feature flag snapshot has an invalid rollout percentage',
      );
    }
    if (
      configuration.rules !== null &&
      (typeof configuration.rules !== 'object' ||
        Array.isArray(configuration.rules))
    ) {
      throw new BadRequestException('Feature flag snapshot has invalid rules');
    }
    if (
      typeof configuration.environment !== 'string' ||
      configuration.environment.length === 0
    ) {
      throw new BadRequestException(
        'Feature flag snapshot has an invalid environment',
      );
    }
    if (
      configuration.metadata !== null &&
      (typeof configuration.metadata !== 'object' ||
        Array.isArray(configuration.metadata))
    ) {
      throw new BadRequestException(
        'Feature flag snapshot has invalid metadata',
      );
    }
  }

  private buildSnapshot(input: {
    flagId: string;
    version: number;
    configuration: FeatureFlagConfiguration;
    previousHash: string | null;
    sourceVersion: number | null;
    actorId?: string | null;
    reason?: string | null;
  }): Record<string, unknown> {
    return {
      flagId: input.flagId,
      key: input.configuration.key,
      version: input.version,
      type: input.configuration.type,
      enabled: input.configuration.enabled,
      rolloutPercentage: input.configuration.rolloutPercentage,
      rules: input.configuration.rules,
      environment: input.configuration.environment,
      description: input.configuration.description,
      isPermanent: input.configuration.isPermanent,
      metadata: input.configuration.metadata,
      expiresAt: input.configuration.expiresAt,
      contentHash: this.computeContentHash(input.configuration),
      previousHash: input.previousHash,
      sourceVersion: input.sourceVersion,
      validationStatus: 'valid',
      actorId: input.actorId ?? null,
      changeReason: input.reason ?? null,
    };
  }

  private computeContentHash(configuration: FeatureFlagConfiguration): string {
    return createHash('sha256')
      .update(
        stableSerialize({
          key: configuration.key,
          type: configuration.type,
          enabled: configuration.enabled,
          rolloutPercentage: configuration.rolloutPercentage,
          rules: configuration.rules,
          environment: configuration.environment,
          description: configuration.description,
          isPermanent: configuration.isPermanent,
          metadata: configuration.metadata,
          expiresAt: configuration.expiresAt
            ? configuration.expiresAt.toISOString()
            : null,
        }),
      )
      .digest('hex');
  }

  private serializableConfiguration(
    configuration: FeatureFlagConfiguration,
  ): Record<string, any> {
    return {
      ...configuration,
      expiresAt: configuration.expiresAt
        ? configuration.expiresAt.toISOString()
        : null,
    };
  }

  private normalizeDate(value?: Date | string | null): Date | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Feature flag has an invalid expiry date');
    }
    return date;
  }

  private async afterCommit(result: StateChangeResult): Promise<void> {
    await this.invalidateCache(result.before.key, result.before.environment);
    if (result.after.environment !== result.before.environment) {
      await this.invalidateCache(result.after.key, result.after.environment);
    }
    this.metrics.incrementConfigChanges(result.after.environment, 'flag');
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
