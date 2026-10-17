import {
  Injectable,
  Logger,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

/**
 * Authorization Policy Service
 *
 * Centralizes role/resource ownership checks and deny-by-default
 * across admin, moderation, configuration, and user-scoped endpoints.
 *
 * Implements V2-BE-066: Enforce Least-Privilege API Authorization Policies
 * Implements PREWAVE-BE-035: Validate Realtime Configuration and Topic Authorization
 */

export enum ResourceType {
  CLAIM = 'claim',
  DISPUTE = 'dispute',
  USER = 'user',
  WALLET = 'wallet',
  CONFIG = 'config',
  CONTRACT = 'contract',
  FEATURE_FLAG = 'feature_flag',
  AUDIT_LOG = 'audit_log',
  METRICS = 'metrics',
  SYSTEM = 'system',
  REALTIME = 'realtime',
  REALTIME_TOPIC = 'realtime_topic',
}

export enum ActionType {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  MODERATE = 'moderate',
  VERIFY = 'verify',
  REJECT = 'reject',
  ESCALATE = 'escalate',
  DEPLOY = 'deploy',
  PAUSE = 'pause',
  UNPAUSE = 'unpause',
  REVOKE = 'revoke',
  OVERRIDE = 'override',
  SUBSCRIBE = 'subscribe',
  PUBLISH = 'publish',
}

export enum Role {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  MODERATOR = 'moderator',
  ANALYST = 'analyst',
  SUPPORT = 'support',
  USER = 'user',
  SERVICE = 'service',
}

export interface Permission {
  resource: ResourceType;
  action: ActionType;
  conditions?: PolicyCondition[];
}

export interface PolicyCondition {
  type: 'ownership' | 'role' | 'scope' | 'time' | 'ip' | 'custom';
  field?: string;
  operator?: 'equals' | 'in' | 'not_in' | 'contains' | 'gt' | 'lt';
  value?: any;
  customEvaluator?: string; // Name of registered custom evaluator
}

export interface AuthorizationContext {
  userId?: string;
  walletAddress?: string;
  roles: Role[];
  permissions: Permission[];
  resourceId?: string;
  resourceType?: ResourceType;
  action?: ActionType;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  resource: ResourceType;
  actions: ActionType[];
  roles: Role[];
  conditions: PolicyCondition[];
  effect: 'allow' | 'deny';
  priority: number; // Higher = evaluated first
  enabled: boolean;
}

/**
 * Realtime configuration schema for stream origins, topics, retention,
 * heartbeat, payload limits, and supported release.
 */
export interface RealtimeTopicDefinition {
  /** Canonical topic name. Must match ^[a-z0-9._:-]+$ and no wildcards. */
  name: string;
  /** Whether the topic carries public data or protected payloads. */
  visibility: 'public' | 'protected';
  /** Roles allowed to subscribe to a protected topic. */
  allowedRoles?: Role[];
  /** Capabilities allowed to subscribe to a protected topic. */
  allowedCapabilities?: string[];
  /** Optional per-topic payload limit in bytes. */
  maxPayloadBytes?: number;
  /** Optional per-topic retention in seconds. */
  retentionSeconds?: number;
}

export interface RealtimeConfiguration {
  /** Allowed stream origins (exact match, no wildcards). */
  origins: string[];
  /** Approved topics. */
  topics: RealtimeTopicDefinition[];
  /** Default retention in seconds. */
  retentionSeconds: number;
  /** Heartbeat interval in seconds. */
  heartbeatSeconds: number;
  /** Maximum payload size in bytes. */
  maxPayloadBytes: number;
  /** Supported release IDs. */
  supportedReleases: string[];
  /** Chain ID the realtime data is bound to. */
  chainId?: string;
  /** Deployment block the realtime data is bound to. */
  deploymentBlock?: number;
  /** Artifact checksum the realtime data is bound to. */
  artifactChecksum?: string;
}

export interface RealtimeSubscriptionRequest {
  topic: string;
  origin?: string;
  releaseId?: string;
  payloadBytes?: number;
  sessionId?: string;
}

export interface RealtimeSubscriptionDecision {
  allowed: boolean;
  reason?: string;
  topic?: RealtimeTopicDefinition;
}

export class RealtimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeConfigurationError';
  }
}

/**
 * Authorization Policy Engine
 */
@Injectable()
export class AuthorizationPolicyService {
  private readonly logger = new Logger(AuthorizationPolicyService.name);
  private policies: Map<string, PolicyRule> = new Map();
  private customEvaluators: Map<
    string,
    (context: AuthorizationContext) => Promise<boolean>
  > = new Map();

  /** Validated realtime configuration (null until validated). */
  private realtimeConfig: RealtimeConfiguration | null = null;
  private ready = false;

  /** Topic name pattern. No wildcards, no Redis/WebSocket metacharacters. */
  private static readonly TOPIC_PATTERN = /^[a-z0-9._:-]{1,128}$/;
  /** Origin pattern. Exact origin match, no wildcards. */
  private static readonly ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
  /** Rejected topic characters (Redis/WebSocket patterns). */
  private static readonly FORBIDDEN_TOPIC_CHARS = /[*?{[}\]\\\s|^>$<]/;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.loadDefaultPolicies();
  }

  /**
   * Load default authorization policies
   */
  private loadDefaultPolicies(): void {
    const defaultPolicies: PolicyRule[] = [
      // SUPER_ADMIN - Full access to everything
      {
        id: 'super-admin-all',
        name: 'Super Admin Full Access',
        description: 'Super admins have unrestricted access to all resources',
        resource: ResourceType.SYSTEM,
        actions: Object.values(ActionType),
        roles: [Role.SUPER_ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 100,
        enabled: true,
      },

      // ADMIN - Most resources except system-level
      {
        id: 'admin-claims',
        name: 'Admin Claim Management',
        description: 'Admins can manage all claims',
        resource: ResourceType.CLAIM,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
          ActionType.ESCALATE,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-disputes',
        name: 'Admin Dispute Management',
        description: 'Admins can manage all disputes',
        resource: ResourceType.DISPUTE,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-users',
        name: 'Admin User Management',
        description: 'Admins can manage users',
        resource: ResourceType.USER,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
          ActionType.REVOKE,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-config',
        name: 'Admin Configuration',
        description: 'Admins can manage configuration',
        resource: ResourceType.CONFIG,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-contracts',
        name: 'Admin Contract Management',
        description: 'Admins can manage contracts',
        resource: ResourceType.CONTRACT,
        actions: [
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.PAUSE,
          ActionType.UNPAUSE,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-audit',
        name: 'Admin Audit Access',
        description: 'Admins can read audit logs',
        resource: ResourceType.AUDIT_LOG,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },

      // MODERATOR - Claims and disputes
      {
        id: 'moderator-claims',
        name: 'Moderator Claim Actions',
        description: 'Moderators can moderate claims',
        resource: ResourceType.CLAIM,
        actions: [
          ActionType.READ,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
          ActionType.ESCALATE,
        ],
        roles: [Role.MODERATOR],
        conditions: [],
        effect: 'allow',
        priority: 80,
        enabled: true,
      },
      {
        id: 'moderator-disputes',
        name: 'Moderator Dispute Actions',
        description: 'Moderators can moderate disputes',
        resource: ResourceType.DISPUTE,
        actions: [
          ActionType.READ,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
        ],
        roles: [Role.MODERATOR],
        conditions: [],
        effect: 'allow',
        priority: 80,
        enabled: true,
      },

      // ANALYST - Read-only access to analytics
      {
        id: 'analyst-read',
        name: 'Analyst Read Access',
        description: 'Analysts can read claims, disputes, and metrics',
        resource: ResourceType.CLAIM,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ANALYST],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },
      {
        id: 'analyst-disputes-read',
        name: 'Analyst Dispute Read',
        description: 'Analysts can read disputes',
        resource: ResourceType.DISPUTE,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ANALYST],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },
      {
        id: 'analyst-metrics',
        name: 'Analyst Metrics',
        description: 'Analysts can read metrics',
        resource: ResourceType.METRICS,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ANALYST],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },

      // SUPPORT - User support operations
      {
        id: 'support-users',
        name: 'Support User Access',
        description: 'Support can view and update user info',
        resource: ResourceType.USER,
        actions: [ActionType.READ, ActionType.UPDATE, ActionType.LIST],
        roles: [Role.SUPPORT],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },
      {
        id: 'support-wallets',
        name: 'Support Wallet Access',
        description: 'Support can view wallet linkages',
        resource: ResourceType.WALLET,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.SUPPORT],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },

      // USER - Own resources only
      {
        id: 'user-own-claims',
        name: 'User Own Claims',
        description: 'Users can read and create their own claims',
        resource: ResourceType.CLAIM,
        actions: [ActionType.CREATE, ActionType.READ, ActionType.LIST],
        roles: [Role.USER],
        conditions: [
          { type: 'ownership', field: 'userId', operator: 'equals' },
        ],
        effect: 'allow',
        priority: 60,
        enabled: true,
      },
      {
        id: 'user-own-disputes',
        name: 'User Own Disputes',
        description: 'Users can read and create their own disputes',
        resource: ResourceType.DISPUTE,
        actions: [ActionType.CREATE, ActionType.READ, ActionType.LIST],
        roles: [Role.USER],
        conditions: [
          { type: 'ownership', field: 'userId', operator: 'equals' },
        ],
        effect: 'allow',
        priority: 60,
        enabled: true,
      },
      {
        id: 'user-own-wallets',
        name: 'User Own Wallets',
        description: 'Users can manage their own wallet linkages',
        resource: ResourceType.WALLET,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
        ],
        roles: [Role.USER],
        conditions: [
          { type: 'ownership', field: 'walletAddress', operator: 'equals' },
        ],
        effect: 'allow',
        priority: 60,
        enabled: true,
      },

      // REALTIME - Public topic subscription for authenticated principals
      {
        id: 'realtime-public-subscribe',
        name: 'Realtime Public Subscribe',
        description: 'Authenticated principals can subscribe to public topics',
        resource: ResourceType.REALTIME_TOPIC,
        actions: [ActionType.SUBSCRIBE],
        roles: [
          Role.SUPER_ADMIN,
          Role.ADMIN,
          Role.MODERATOR,
          Role.ANALYST,
          Role.SUPPORT,
          Role.USER,
          Role.SERVICE,
        ],
        conditions: [],
        effect: 'allow',
        priority: 50,
        enabled: true,
      },

      // Deny by default for sensitive operations
      {
        id: 'deny-contract-deploy',
        name: 'Deny Contract Deploy',
        description: 'Only super admins can deploy contracts',
        resource: ResourceType.CONTRACT,
        actions: [ActionType.DEPLOY],
        roles: [
          Role.ADMIN,
          Role.MODERATOR,
          Role.ANALYST,
          Role.SUPPORT,
          Role.USER,
        ],
        conditions: [],
        effect: 'deny',
        priority: 1000,
        enabled: true,
      },
      {
        id: 'deny-config-delete',
        name: 'Deny Config Delete',
        description: 'Prevent accidental config deletion',
        resource: ResourceType.CONFIG,
        actions: [ActionType.DELETE],
        roles: [
          Role.ADMIN,
          Role.MODERATOR,
          Role.ANALYST,
          Role.SUPPORT,
          Role.USER,
        ],
        conditions: [],
        effect: 'deny',
        priority: 1000,
        enabled: true,
      },
      {
        id: 'deny-audit-write',
        name: 'Deny Audit Write',
        description: 'Audit logs are append-only',
        resource: ResourceType.AUDIT_LOG,
        actions: [ActionType.CREATE, ActionType.UPDATE, ActionType.DELETE],
        roles: [
          Role.ADMIN,
          Role.MODERATOR,
          Role.ANALYST,
          Role.SUPPORT,
          Role.USER,
        ],
        conditions: [],
        effect: 'deny',
        priority: 1000,
        enabled: true,
      },
    ];

    for (const policy of defaultPolicies) {
      this.policies.set(policy.id, policy);
    }
  }

  /**
   * Register a custom condition evaluator.
   */
  registerCustomEvaluator(
    name: string,
    evaluator: (context: AuthorizationContext) => Promise<boolean>,
  ): void {
    this.customEvaluators.set(name, evaluator);
  }

  /**
   * Add or replace a policy rule.
   */
  addPolicy(policy: PolicyRule): void {
    this.policies.set(policy.id, policy);
  }

  /**
   * Evaluate authorization for a given context. Deny-by-default.
   */
  async isAuthorized(context: AuthorizationContext): Promise<boolean> {
    if (!context.resourceType || !context.action) {
      return false;
    }

    const applicable = Array.from(this.policies.values())
      .filter(
        (p) =>
          p.enabled &&
          p.resource === context.resourceType &&
          p.actions.includes(context.action!),
      )
      .sort((a, b) => b.priority - a.priority);

    for (const policy of applicable) {
      const roleMatch = policy.roles.some((r) => context.roles.includes(r));
      if (!roleMatch) {
        continue;
      }

      const conditionsMatch = await this.evaluateConditions(policy.conditions, context);
      if (!conditionsMatch) {
        continue;
      }

      if (policy.effect === 'deny') {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Evaluate a list of policy conditions.
   */
  private async evaluateConditions(
    conditions: PolicyCondition[],
    context: AuthorizationContext,
  ): Promise<boolean> {
    for (const condition of conditions) {
      const ok = await this.evaluateCondition(condition, context);
      if (!ok) {
        return false;
      }
    }
    return true;
  }

  private async evaluateCondition(
    condition: PolicyCondition,
    context: AuthorizationContext,
  ): Promise<boolean> {
    switch (condition.type) {
      case 'ownership': {
        const field = condition.field as keyof AuthorizationContext;
        const contextValue = context[field];
        const resourceValue = context.metadata?.[condition.field ?? ''];
        if (contextValue === undefined || resourceValue === undefined) {
          return false;
        }
        return String(contextValue) === String(resourceValue);
      }
      case 'role':
        return context.roles.includes(condition.value as Role);
      case 'scope':
        return (context.metadata?.scopes ?? []).includes(condition.value);
      case 'time': {
        const now = Date.now();
        const target = new Date(condition.value);
        return condition.operator === 'lt' ? now < target.getTime() : now > target.getTime();
      }
      case 'ip':
        return condition.value === context.ipAddress;
      case 'custom': {
        const evaluator = condition.customEvaluator
          ? this.customEvaluators.get(condition.customEvaluator)
          : undefined;
        if (!evaluator) {
          return false;
        }
        return evaluator(context);
      }
      default:
        return false;
    }
  }

  /**
   * Load and validate realtime configuration. Fails closed on invalid config.
   */
  loadRealtimeConfiguration(
    raw?: RealtimeConfiguration,
  ): RealtimeConfiguration {
    const config = raw ?? this.readRealtimeConfigFromEnv();
    this.validateRealtimeConfiguration(config);
    this.realtimeConfig = config;
    this.ready = true;
    return config;
  }

  /**
   * Returns true only after a valid realtime configuration has been loaded.
   */
  isReady(): boolean {
    return this.ready && this.realtimeConfig !== null;
  }

  getRealtimeConfiguration(): RealtimeConfiguration | null {
    return this.realtimeConfig;
  }

  private readRealtimeConfigFromEnv(): RealtimeConfiguration {
    const origins = this.parseList(this.configService.get<string>('REALTIME_ORIGINS'));
    const topics = this.parseTopics(
      this.configService.get<string>('REALTIME_TOPICS'),
    );
    const retentionSeconds = this.parseIntConfig('REALTIME_RETENTION_SECONDS');
    const heartbeatSeconds = this.parseIntConfig('REALTIME_HEARTBEAT_SECONDS');
    const maxPayloadBytes = this.parseIntConfig('REALTIME_MAX_PAYLOAD_BYTES');
    const supportedReleases = this.parseList(
      this.configService.get<string>('REALTIME_SUPPORTED_RELEASES'),
    );

    return {
      origins,
      topics,
      retentionSeconds,
      heartbeatSeconds,
      maxPayloadBytes,
      supportedReleases,
      chainId: this.configService.get<string>('CHAIN_ID'),
      deploymentBlock: this.parseOptionalInt('DEPLOYMENT_BLOCK'),
      artifactChecksum: this.configService.get<string>('ARTIFACT_CHECKSUM'),
    };
  }

  private parseList(value?: string): string[] {
    if (!value) {
      return [];
    }
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  private parseTopics(value?: string): RealtimeTopicDefinition[] {
    if (!value) {
      return [];
    }
    return this.parseList(value).map((entry) => {
      // Format: name:visibility[:role1,...]
      const [name, visibilityRaw, rolesRaw] = entry.split(':');
      const visibility = visibilityRaw === 'protected' ? 'protected' : 'public';
      const allowedRoles = rolesRaw
        ? (rolesRaw.split('|') as Role[])
        : undefined;
      return {
        name,
        visibility,
        allowedRoles,
      };
    });
  }

  private parseIntConfig(key: string): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw === undefined ? NaN : Number(raw);
    return parsed;
  }

  private parseOptionalInt(key: string): number | undefined {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === '') {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Validate realtime configuration. Throws RealtimeConfigurationError on invalid config.
   */
  validateRealtimeConfiguration(config: RealtimeConfiguration): void {
    const errors: string[] = [];

    if (!Array.isArray(config.origins) || config.origins.length === 0) {
      errors.push('origins must be a non-empty array');
    } else {
      for (const origin of config.origins) {
        if (!AuthorizationPolicyService.ORIGIN_PATTERN.test(origin)) {
          errors.push(`invalid origin: ${origin}`);
        }
      }
    }

    if (!Array.isArray(config.topics) || config.topics.length === 0) {
      errors.push('topics must be a non-empty array');
    } else {
      const seenNames = new Set<string>();
      for (const topic of config.topics) {
        if (!this.isValidTopicName(topic.name)) {
          errors.push(`invalid topic name: ${topic.name}`);
        }
        if (seenNames.has(topic.name)) {
          errors.push(`duplicate topic name: ${topic.name}`);
        }
        seenNames.add(topic.name);
        if (topic.visibility !== 'public' && topic.visibility !== 'protected') {
          errors.push(`invalid visibility for topic ${topic.name}`);
        }
        if (topic.visibility === 'protected') {
          const hasRoles = Array.isArray(topic.allowedRoles) && topic.allowedRoles.length > 0;
          const hasCapabilities =
            Array.isArray(topic.allowedCapabilities) &&
            topic.allowedCapabilities.length > 0;
          if (!hasRoles && !hasCapabilities) {
            errors.push(
              `protected topic ${topic.name} must declare allowedRoles or allowedCapabilities`,
            );
          }
        }
        if (
          topic.maxPayloadBytes !== undefined &&
          (!Number.isFinite(topic.maxPayloadBytes) || topic.maxPayloadBytes <= 0)
        ) {
          errors.push(`invalid maxPayloadBytes for topic ${topic.name}`);
        }
        if (
          topic.retentionSeconds !== undefined &&
          (!Number.isFinite(topic.retentionSeconds) || topic.retentionSeconds <= 0)
        ) {
          errors.push(`invalid retentionSeconds for topic ${topic.name}`);
        }
      }
    }

    if (!Number.isFinite(config.retentionSeconds) || config.retentionSeconds <= 0) {
      errors.push('retentionSeconds must be a positive integer');
    }
    if (!Number.isFinite(config.heartbeatSeconds) || config.heartbeatSeconds <= 0) {
      errors.push('heartbeatSeconds must be a positive integer');
    }
    if (!Number.isFinite(config.maxPayloadBytes) || config.maxPayloadBytes <= 0) {
      errors.push('maxPayloadBytes must be a positive integer');
    }
    if (!Array.isArray(config.supportedReleases) || config.supportedReleases.length === 0) {
      errors.push('supportedReleases must be a non-empty array');
    }
    if (config.deploymentBlock !== undefined) {
      if (!Number.isFinite(config.deploymentBlock) || config.deploymentBlock < 0) {
        errors.push('deploymentBlock must be a non-negative integer');
      }
    }

    if (errors.length > 0) {
      this.ready = false;
      this.logger.error(`Invalid realtime configuration: ${errors.join('; ')}`);
      throw new RealtimeConfigurationError(errors.join('; '));
    }
  }

  /**
   * Static entry point used by startup validation to fail closed on invalid
   * realtime configuration without instantiating the service.
   */
  static validateRealtimeConfiguration(config: RealtimeConfiguration): void {
    new AuthorizationPolicyService(
      { get: () => undefined } as unknown as ConfigService,
      {} as unknown as RedisService,
    ).validateRealtimeConfiguration(config);
  }

  /**
   * Topic names must not contain Redis/WebSocket pattern metacharacters.
   */
  isValidTopicName(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0) {
      return false;
    }
    if (AuthorizationPolicyService.FORBIDDEN_TOPIC_CHARS.test(name)) {
      return false;
    }
    return AuthorizationPolicyService.TOPIC_PATTERN.test(name);
  }

  /**
   * Authorize a subscription request against the validated realtime config.
   * Fails closed on stale, missing, ambiguous, or unauthorized state.
   */
  async authorizeSubscription(
    request: RealtimeSubscriptionRequest,
    context: AuthorizationContext,
  ): Promise<RealtimeSubscriptionDecision> {
    if (!this.isReady() || !this.realtimeConfig) {
      return { allowed: false, reason: 'realtime configuration not ready' };
    }

    const config = this.realtimeConfig;

    // Origin check
    if (request.origin !== undefined) {
      if (!config.origins.includes(request.origin)) {
        return { allowed: false, reason: 'origin not allowed' };
      }
    }

    // Release check
    if (request.releaseId !== undefined) {
      if (!config.supportedReleases.includes(request.releaseId)) {
        return { allowed: false, reason: 'stale or unsupported release' };
      }
    }

    // Session revocation check
    if (request.sessionId !== undefined) {
      const revoked = await this.isSessionRevoked(request.sessionId);
      if (revoked) {
        return { allowed: false, reason: 'session revoked' };
      }
    }

    // Topic validity and approval
    if (!this.isValidTopicName(request.topic)) {
      return { allowed: false, reason: 'invalid topic name' };
    }
    const topic = config.topics.find((t) => t.name === request.topic);
    if (!topic) {
      return { allowed: false, reason: 'unknown topic' };
    }

    // Payload limit check
    const effectiveLimit = topic.maxPayloadBytes ?? config.maxPayloadBytes;
    if (request.payloadBytes !== undefined && request.payloadBytes > effectiveLimit) {
      return { allowed: false, reason: 'oversized payload' };
    }

    // Public topics are subscribable by any authenticated principal.
    if (topic.visibility === 'public') {
      const allowed = await this.isAuthorized({
        ...context,
        resourceType: ResourceType.REALTIME_TOPIC,
        action: ActionType.SUBSCRIBE,
        metadata: { ...(context.metadata ?? {}), topic: topic.name },
      });
      return allowed
        ? { allowed: true, topic }
        : { allowed: false, reason: 'unauthorized', topic };
    }

    // Protected topics require explicit role or capability match.
    const roleMatch =
      Array.isArray(topic.allowedRoles) &&
      topic.allowedRoles.some((r) => context.roles.includes(r));
    const capabilities = (context.metadata?.capabilities ?? []) as string[];
    const capabilityMatch =
      Array.isArray(topic.allowedCapabilities) &&
      topic.allowedCapabilities.some((c) => capabilities.includes(c));

    if (!roleMatch && !capabilityMatch) {
      return { allowed: false, reason: 'unauthorized for protected topic', topic };
    }

    return { allowed: true, topic };
  }

  private async isSessionRevoked(sessionId: string): Promise<boolean> {
    try {
      const client = (this.redisService as unknown as { client?: { get(key: string): Promise<string | null> } }).client;
      if (!client) {
        // Fail closed when revocation state is unavailable.
        return true;
      }
      const value = await client.get(`revoked:session:${sessionId}`);
      return value !== null && value !== undefined;
    } catch (error) {
      this.logger.warn(`Session revocation check failed; failing closed: ${(error as Error).message}`);
      return true;
    }
  }
}

/**
 * Guard that enforces role/resource authorization for HTTP routes.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorizationPolicy: AuthorizationPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredResource = this.reflector.get<ResourceType>('resource', context.getHandler());
    const requiredAction = this.reflector.get<ActionType>('action', context.getHandler());

    if (!requiredResource || !requiredAction) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const principal = request.user as AuthorizationContext | undefined;
    if (!principal) {
      throw new ForbiddenException('No authenticated principal');
    }

    const allowed = await this.authorizationPolicy.isAuthorized({
      ...principal,
      resourceType: requiredResource,
      action: requiredAction,
      resourceId: request.params.id,
    });

    if (!allowed) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
