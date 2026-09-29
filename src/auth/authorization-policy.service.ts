import { Injectable, Logger, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';

/**
 * Authorization Policy Service
 *
 * Centralizes role/resource ownership checks and deny-by-default
 * across admin, moderation, configuration, and user-scoped endpoints.
 *
 * Implements V2-BE-066: Enforce Least-Privilege API Authorization Policies
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
 * Authorization Policy Engine
 */
@Injectable()
export class AuthorizationPolicyService {
  private readonly logger = new Logger(AuthorizationPolicyService.name);
  private policies: Map<string, PolicyRule> = new Map();
  private customEvaluators: Map<string, (context: AuthorizationContext) => Promise<boolean>> = new Map();

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
        actions: [ActionType.CREATE, ActionType.READ, ActionType.UPDATE, ActionType.DELETE, ActionType.LIST, ActionType.MODERATE, ActionType.VERIFY, ActionType.REJECT, ActionType.ESCALATE],
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
        actions: [ActionType.CREATE, ActionType.READ, ActionType.UPDATE, ActionType.DELETE, ActionType.LIST, ActionType.MODERATE, ActionType.VERIFY, ActionType.REJECT],
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
        actions: [ActionType.CREATE, ActionType.READ, ActionType.UPDATE, ActionType.DELETE, ActionType.LIST, ActionType.REVOKE],
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
        actions: [ActionType.CREATE, ActionType.READ, ActionType.UPDATE, ActionType.DELETE, ActionType.LIST],
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
        actions: [ActionType.READ, ActionType.UPDATE, ActionType.PAUSE, ActionType.UNPAUSE],
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
        actions: [ActionType.READ, ActionType.LIST, ActionType.MODERATE, ActionType.VERIFY, ActionType.REJECT, ActionType.ESCALATE],
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
        actions: [ActionType.READ, ActionType.LIST, ActionType.MODERATE, ActionType.VERIFY, ActionType.REJECT],
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
        actions: [ActionType.CREATE, ActionType.READ, ActionType.UPDATE, ActionType.DELETE, ActionType.LIST],
        roles: [Role.USER],
        conditions: [
          { type: 'ownership', field: 'walletAddress', operator: 'equals' },
        ],
        effect: 'allow',
        priority: 60,
        enabled: true,
      },

      // Deny by default for sensitive operations
      {
        id: 'deny-contract-deploy',
        name: 'Deny Contract Deploy',
        description: 'Only super admins can deploy contracts',
        resource: ResourceType.CONTRACT,
        actions: [ActionType.DEPLOY],
        roles: [Role.ADMIN, Role.MODERATOR, Role.ANALYST, Role.SUPPORT, Role.USER],
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
        roles: [Role.ADMIN, Role.MODERATOR, Role.ANALYST, Role.SUPPORT, Role.USER],
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
        roles: Object.values(Role),
        conditions: [],
        effect: 'deny',
        priority: 1000,
        enabled: true,
      },
    ];

    for (const policy of defaultPolicies) {
      this.policies.set(policy.id, policy);
    }

    this.logger.log(`Loaded ${this.policies.size} default authorization policies`);
  }

  /**
   * Register a custom policy condition evaluator
   */
  registerCustomEvaluator(name: string, evaluator: (context: AuthorizationContext) => Promise<boolean>): void {
    this.customEvaluators.set(name, evaluator);
    this.logger.log(`Registered custom evaluator: ${name}`);
  }

  /**
   * Add or update a policy rule
   */
  setPolicy(policy: PolicyRule): void {
    this.policies.set(policy.id, policy);
    this.logger.log(`Policy updated: ${policy.id} (${policy.effect})`);
  }

  /**
   * Remove a policy rule
   */
  removePolicy(policyId: string): boolean {
    const removed = this.policies.delete(policyId);
    if (removed) {
      this.logger.log(`Policy removed: ${policyId}`);
    }
    return removed;
  }

  /**
   * Check if an action is authorized
   */
  async authorize(context: AuthorizationContext): Promise<{
    allowed: boolean;
    matchedPolicy?: PolicyRule;
    reason: string;
  }> {
    // Get applicable policies sorted by priority (highest first)
    const applicablePolicies = Array.from(this.policies.values())
      .filter((p) => p.enabled && p.resource === context.resourceType && p.actions.includes(context.action!))
      .sort((a, b) => b.priority - a.priority);

    if (applicablePolicies.length === 0) {
      // Deny by default - no matching policy
      return {
        allowed: false,
        reason: `No policy allows ${context.action} on ${context.resourceType}`,
      };
    }

    // Evaluate each policy in priority order
    for (const policy of applicablePolicies) {
      // Check role match
      if (!policy.roles.some((role) => context.roles.includes(role))) {
        continue;
      }

      // Check conditions
      const conditionsMet = await this.evaluateConditions(policy.conditions, context);
      if (!conditionsMet) {
        continue;
      }

      // Policy matches
      if (policy.effect === 'allow') {
        return {
          allowed: true,
          matchedPolicy: policy,
          reason: `Allowed by policy: ${policy.name}`,
        };
      } else {
        return {
          allowed: false,
          matchedPolicy: policy,
          reason: `Denied by policy: ${policy.name}`,
        };
      }
    }

    // No policy allowed the action
    return {
      allowed: false,
      reason: `No policy allows ${context.action} on ${context.resourceType} for roles: ${context.roles.join(', ')}`,
    };
  }

  /**
   * Evaluate policy conditions
   */
  private async evaluateConditions(conditions: PolicyCondition[], context: AuthorizationContext): Promise<boolean> {
    for (const condition of conditions) {
      const met = await this.evaluateCondition(condition, context);
      if (!met) {
        return false;
      }
    }
    return true;
  }

  /**
   * Evaluate a single condition
   */
  private async evaluateCondition(condition: PolicyCondition, context: AuthorizationContext): Promise<boolean> {
    switch (condition.type) {
      case 'ownership':
        return this.evaluateOwnership(condition, context);

      case 'role':
        return this.evaluateRole(condition, context);

      case 'scope':
        return this.evaluateScope(condition, context);

      case 'time':
        return this.evaluateTime(condition, context);

      case 'ip':
        return this.evaluateIp(condition, context);

      case 'custom':
        return this.evaluateCustom(condition, context);

      default:
        this.logger.warn(`Unknown condition type: ${condition.type}`);
        return false;
    }
  }

  private evaluateOwnership(condition: PolicyCondition, context: AuthorizationContext): boolean {
    if (!condition.field) return false;

    const resourceValue = context.metadata?.[condition.field];
    const userValue = condition.field === 'userId' ? context.userId : context.walletAddress;

    if (!resourceValue || !userValue) return false;

    switch (condition.operator) {
      case 'equals':
        return resourceValue.toLowerCase() === userValue.toLowerCase();
      case 'in':
        return Array.isArray(resourceValue) && resourceValue.some((v: string) => v.toLowerCase() === userValue.toLowerCase());
      default:
        return resourceValue.toLowerCase() === userValue.toLowerCase();
    }
  }

  private evaluateRole(condition: PolicyCondition, context: AuthorizationContext): boolean {
    if (!condition.value) return false;
    const requiredRoles = Array.isArray(condition.value) ? condition.value : [condition.value];
    return requiredRoles.some((role: string) => context.roles.includes(role as Role));
  }

  private evaluateScope(condition: PolicyCondition, context: AuthorizationContext): boolean {
    // Scope-based conditions (e.g., organization, team, project)
    if (!condition.field || !condition.value) return false;
    const scopeValue = context.metadata?.[condition.field];
    const requiredScope = condition.value;
    return scopeValue === requiredScope;
  }

  private evaluateTime(condition: PolicyCondition, context: AuthorizationContext): boolean {
    // Time-based conditions (e.g., business hours, maintenance windows)
    const now = new Date();
    const hour = now.getHours();

    if (condition.field === 'businessHours') {
      return hour >= 9 && hour < 18; // 9 AM - 6 PM
    }

    if (condition.field === 'maintenanceWindow') {
      // Check if in maintenance window
      const maintenanceStart = this.configService.get<string>('MAINTENANCE_WINDOW_START', '02:00');
      const maintenanceEnd = this.configService.get<string>('MAINTENANCE_WINDOW_END', '04:00');
      const [startHour, startMin] = maintenanceStart.split(':').map(Number);
      const [endHour, endMin] = maintenanceEnd.split(':').map(Number);

      const currentMinutes = hour * 60 + now.getMinutes();
      const startMinutes = startHour * 60 + startMin;
      const endMinutes = endHour * 60 + endMin;

      if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
      } else {
        // Overnight window
        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
      }
    }

    return true;
  }

  private evaluateIp(condition: PolicyCondition, context: AuthorizationContext): boolean {
    if (!context.ipAddress || !condition.value) return false;

    const allowedIps = Array.isArray(condition.value) ? condition.value : [condition.value];

    switch (condition.operator) {
      case 'in':
        return allowedIps.some((ip: string) => this.ipMatches(context.ipAddress!, ip));
      case 'not_in':
        return !allowedIps.some((ip: string) => this.ipMatches(context.ipAddress!, ip));
      default:
        return allowedIps.some((ip: string) => this.ipMatches(context.ipAddress!, ip));
    }
  }

  private ipMatches(ip: string, pattern: string): boolean {
    if (pattern.includes('/')) {
      // CIDR notation
      const [rangeIp, prefix] = pattern.split('/');
      return this.cidrMatch(ip, rangeIp, parseInt(prefix, 10));
    }
    return ip === pattern;
  }

  private cidrMatch(ip: string, rangeIp: string, prefix: number): boolean {
    const ipParts = ip.split('.').map(Number);
    const rangeParts = rangeIp.split('.').map(Number);

    const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const rangeNum = (rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3];

    const mask = ~((1 << (32 - prefix)) - 1);
    return (ipNum & mask) === (rangeNum & mask);
  }

  private async evaluateCustom(condition: PolicyCondition, context: AuthorizationContext): Promise<boolean> {
    if (!condition.customEvaluator) return false;

    const evaluator = this.customEvaluators.get(condition.customEvaluator);
    if (!evaluator) {
      this.logger.warn(`Custom evaluator not found: ${condition.customEvaluator}`);
      return false;
    }

    try {
      return await evaluator(context);
    } catch (error) {
      this.logger.error(`Custom evaluator ${condition.customEvaluator} failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get all policies for a resource
   */
  getPoliciesForResource(resource: ResourceType): PolicyRule[] {
    return Array.from(this.policies.values())
      .filter((p) => p.resource === resource && p.enabled)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all policies
   */
  getAllPolicies(): PolicyRule[] {
    return Array.from(this.policies.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Export policies for auditing
   */
  exportPolicies(): string {
    return JSON.stringify(this.getAllPolicies(), null, 2);
  }
}

/**
 * Authorization Guard for NestJS
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly policyService: AuthorizationPolicyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Get required permission from route metadata
    const requiredPermission = this.reflector.get<Permission>('permission', context.getHandler());

    if (!requiredPermission) {
      // No permission required - allow if authenticated
      return true;
    }

    // Build authorization context
    const authContext: AuthorizationContext = {
      userId: user.sub || user.userId,
      walletAddress: user.address,
      roles: user.roles || [Role.USER],
      permissions: user.permissions || [],
      resourceId: request.params.id || request.body?.id,
      resourceType: requiredPermission.resource,
      action: requiredPermission.action,
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
      metadata: {
        ...request.params,
        ...request.body,
        ...request.query,
      },
    };

    const result = await this.policyService.authorize(authContext);

    if (!result.allowed) {
      this.policyService.logger.warn(`Authorization denied: ${result.reason}`, {
        userId: authContext.userId,
        resource: authContext.resourceType,
        action: authContext.action,
        roles: authContext.roles,
      });
      throw new ForbiddenException(result.reason);
    }

    return true;
  }
}

/**
 * Decorator for declaring required permissions
 */
export const RequirePermission = (permission: Permission) => {
  return (target: any, propertyKey?: string, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata('permission', permission, descriptor.value);
    } else {
      Reflect.defineMetadata('permission', permission, target);
    }
    return descriptor ?? target;
  };
};

/**
 * Decorator for declaring required roles
 */
export const RequireRoles = (...roles: Role[]) => {
  return (target: any, propertyKey?: string, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata('roles', roles, descriptor.value);
    } else {
      Reflect.defineMetadata('roles', roles, target);
    }
    return descriptor ?? target;
  };
};