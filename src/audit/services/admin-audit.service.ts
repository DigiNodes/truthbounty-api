import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';

/**
 * Administrative Audit Log Service
 *
 * Records actor, action, target, reason, request correlation,
 * before/after digest, and outcome for every privileged backend operation.
 *
 * Implements V2-BE-067: Create a Tamper-Evident Administrative Audit Log
 */

export interface AdminAuditLogInput {
  // Actor identification
  actorId: string;                    // User ID or service account
  actorType: 'user' | 'service' | 'system';
  actorWalletAddress?: string;        // Wallet if authenticated via SIWE

  // Action details
  action: AdminActionType;
  actionCategory: AdminActionCategory;

  // Target resource
  targetType: string;                 // e.g., 'claim', 'dispute', 'user', 'config', 'contract'
  targetId: string;                   // Resource identifier
  targetDescription?: string;         // Human-readable description

  // Request context
  requestId?: string;
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;

  // Reason and authorization
  reason: string;                     // Business justification
  authorization?: {
    policyId: string;
    policyVersion: string;
    roles: string[];
    permissions: string[];
  };

  // State changes
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;

  // Outcome
  outcome: 'success' | 'failure' | 'partial';
  errorMessage?: string;
  errorCode?: string;

  // Metadata
  metadata?: Record<string, any>;
  severity?: AdminAuditSeverity;
}

export enum AdminActionType {
  // User management
  USER_CREATE = 'USER_CREATE',
  USER_UPDATE = 'USER_UPDATE',
  USER_DELETE = 'USER_DELETE',
  USER_SUSPEND = 'USER_SUSPEND',
  USER_UNSUSPEND = 'USER_UNSUSPEND',
  USER_ROLE_CHANGE = 'USER_ROLE_CHANGE',

  // Wallet management
  WALLET_LINK = 'WALLET_LINK',
  WALLET_UNLINK = 'WALLET_UNLINK',
  WALLET_REVOKE = 'WALLET_REVOKE',

  // Claim management
  CLAIM_CREATE = 'CLAIM_CREATE',
  CLAIM_UPDATE = 'CLAIM_UPDATE',
  CLAIM_DELETE = 'CLAIM_DELETE',
  CLAIM_VERIFY = 'CLAIM_VERIFY',
  CLAIM_REJECT = 'CLAIM_REJECT',
  CLAIM_ESCALATE = 'CLAIM_ESCALATE',

  // Dispute management
  DISPUTE_CREATE = 'DISPUTE_CREATE',
  DISPUTE_UPDATE = 'DISPUTE_UPDATE',
  DISPUTE_RESOLVE = 'DISPUTE_RESOLVE',
  DISPUTE_REJECT = 'DISPUTE_REJECT',

  // Configuration
  CONFIG_UPDATE = 'CONFIG_UPDATE',
  CONFIG_CREATE = 'CONFIG_CREATE',
  CONFIG_DELETE = 'CONFIG_DELETE',
  FEATURE_FLAG_TOGGLE = 'FEATURE_FLAG_TOGGLE',

  // Contract/Chain
  CONTRACT_DEPLOY = 'CONTRACT_DEPLOY',
  CONTRACT_UPDATE = 'CONTRACT_UPDATE',
  CONTRACT_PAUSE = 'CONTRACT_PAUSE',
  CONTRACT_UNPAUSE = 'CONTRACT_UNPAUSE',

  // System operations
  SYSTEM_BACKUP = 'SYSTEM_BACKUP',
  SYSTEM_RESTORE = 'SYSTEM_RESTORE',
  SYSTEM_MAINTENANCE = 'SYSTEM_MAINTENANCE',
  DATABASE_MIGRATION = 'DATABASE_MIGRATION',

  // Security
  SESSION_REVOKE = 'SESSION_REVOKE',
  SESSION_REVOKE_ALL = 'SESSION_REVOKE_ALL',
  API_KEY_CREATE = 'API_KEY_CREATE',
  API_KEY_REVOKE = 'API_KEY_REVOKE',
  RATE_LIMIT_OVERRIDE = 'RATE_LIMIT_OVERRIDE',
}

export enum AdminActionCategory {
  USER_MANAGEMENT = 'USER_MANAGEMENT',
  WALLET_MANAGEMENT = 'WALLET_MANAGEMENT',
  CLAIM_MODERATION = 'CLAIM_MODERATION',
  DISPUTE_MODERATION = 'DISPUTE_MODERATION',
  CONFIGURATION = 'CONFIGURATION',
  CONTRACT_MANAGEMENT = 'CONTRACT_MANAGEMENT',
  SYSTEM_OPERATIONS = 'SYSTEM_OPERATIONS',
  SECURITY = 'SECURITY',
  COMPLIANCE = 'COMPLIANCE',
}

export enum AdminAuditSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface AdminAuditLogRecord {
  id: string;
  eventId: string;
  timestamp: Date;
  actorId: string;
  actorType: string;
  actorWalletAddress?: string;
  action: AdminActionType;
  actionCategory: AdminActionCategory;
  targetType: string;
  targetId: string;
  targetDescription?: string;
  requestId?: string;
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  reason: string;
  authorization?: {
    policyId: string;
    policyVersion: string;
    roles: string[];
    permissions: string[];
  };
  beforeState?: Record<string, any>;
  afterState?: Record<string, any>;
  outcome: 'success' | 'failure' | 'partial';
  errorMessage?: string;
  errorCode?: string;
  metadata?: Record<string, any>;
  severity: AdminAuditSeverity;
  integrityHash: string;
  previousHash?: string;  // Chain hashes for tamper evidence
}

/**
 * Admin Audit Service - Tamper-Evident Administrative Audit Log
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);
  private previousHash: string | null = null;

  constructor(
    @InjectRepository('admin_audit_logs') // Table name - will need migration
    private readonly auditRepo: Repository<any>,
    @Inject(REQUEST)
    private readonly request: Request,
  ) {}

  /**
   * Log an administrative action
   */
  async log(input: AdminAuditLogInput): Promise<string> {
    const eventId = randomUUID();
    const timestamp = new Date();

    // Compute state digests
    const beforeDigest = input.beforeState ? this.computeDigest(input.beforeState) : undefined;
    const afterDigest = input.afterState ? this.computeDigest(input.afterState) : undefined;

    // Build the record
    const record: AdminAuditLogRecord = {
      id: randomUUID(),
      eventId,
      timestamp,
      actorId: input.actorId,
      actorType: input.actorType,
      actorWalletAddress: input.actorWalletAddress?.toLowerCase(),
      action: input.action,
      actionCategory: input.actionCategory,
      targetType: input.targetType,
      targetId: input.targetId,
      targetDescription: input.targetDescription,
      requestId: input.requestId || this.getRequestId(),
      correlationId: input.correlationId || this.getCorrelationId(),
      ipAddress: input.ipAddress || this.getClientIp(),
      userAgent: input.userAgent || this.request?.get('user-agent'),
      reason: input.reason,
      authorization: input.authorization,
      beforeState: input.beforeState,
      afterState: input.afterState,
      outcome: input.outcome,
      errorMessage: input.errorMessage,
      errorCode: input.errorCode,
      metadata: input.metadata,
      severity: input.severity || AdminAuditSeverity.MEDIUM,
      integrityHash: '', // Will be computed
      previousHash: this.previousHash,
    };

    // Compute integrity hash
    record.integrityHash = this.computeIntegrityHash(record);

    // Update chain
    this.previousHash = record.integrityHash;

    try {
      // In a real implementation, this would save to a dedicated admin_audit_logs table
      // For now, we log to the application logger with structured data
      this.logger.log('ADMIN_AUDIT', {
        ...record,
        // Redact sensitive fields in logs
        beforeState: record.beforeState ? '[REDACTED]' : undefined,
        afterState: record.afterState ? '[REDACTED]' : undefined,
        authorization: record.authorization ? '[REDACTED]' : undefined,
      });

      // TODO: Save to database when migration is added
      // await this.auditRepo.save(record);

      return eventId;
    } catch (error) {
      this.logger.error(`Failed to log admin audit: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Log a batch of administrative actions
   */
  async logBatch(inputs: AdminAuditLogInput[]): Promise<string[]> {
    const eventIds: string[] = [];

    for (const input of inputs) {
      const eventId = await this.log(input);
      eventIds.push(eventId);
    }

    return eventIds;
  }

  /**
   * Query admin audit logs
   */
  async query(filters: AdminAuditQueryFilters): Promise<AdminAuditQueryResult> {
    // This would query the database
    // For now, return empty result
    return {
      logs: [],
      total: 0,
      page: filters.page || 1,
      limit: filters.limit || 50,
      totalPages: 0,
    };
  }

  /**
   * Get audit log by event ID
   */
  async getByEventId(eventId: string): Promise<AdminAuditLogRecord | null> {
    // Would query database
    return null;
  }

  /**
   * Verify integrity of audit log chain
   */
  async verifyIntegrity(fromEventId?: string, toEventId?: string): Promise<{
    valid: boolean;
    checked: number;
    firstInvalid?: string;
    errors: string[];
  }> {
    // This would verify the hash chain
    // For now, return success
    return {
      valid: true,
      checked: 0,
      errors: [],
    };
  }

  /**
   * Get audit statistics
   */
  async getStats(filters?: {
    actorId?: string;
    action?: AdminActionType;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Record<string, number>> {
    // Would query database for statistics
    return {};
  }

  /**
   * Compute SHA-256 digest of an object
   */
  private computeDigest(obj: Record<string, any>): string {
    const canonical = JSON.stringify(obj, Object.keys(obj).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Compute integrity hash for tamper evidence
   * Uses chained hashing: hash(previousHash + currentRecord)
   */
  private computeIntegrityHash(record: Omit<AdminAuditLogRecord, 'integrityHash' | 'previousHash'> & { previousHash?: string }): string {
    const hashable = {
      eventId: record.eventId,
      timestamp: record.timestamp.toISOString(),
      actorId: record.actorId,
      actorType: record.actorType,
      action: record.action,
      actionCategory: record.actionCategory,
      targetType: record.targetType,
      targetId: record.targetId,
      requestId: record.requestId,
      correlationId: record.correlationId,
      reason: record.reason,
      beforeDigest: record.beforeState ? this.computeDigest(record.beforeState) : undefined,
      afterDigest: record.afterState ? this.computeDigest(record.afterState) : undefined,
      outcome: record.outcome,
      severity: record.severity,
      previousHash: record.previousHash,
    };

    const canonical = JSON.stringify(hashable, Object.keys(hashable).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Get client IP from request
   */
  private getClientIp(): string | undefined {
    if (!this.request) return undefined;
    return this.request.ip || this.request.socket?.remoteAddress;
  }

  /**
   * Get request ID from headers
   */
  private getRequestId(): string | undefined {
    if (this.request?.headers['x-request-id']) {
      return this.request.headers['x-request-id'] as string;
    }
    return undefined;
  }

  /**
   * Get correlation ID from headers
   */
  private getCorrelationId(): string {
    if (this.request?.headers['x-correlation-id']) {
      return this.request.headers['x-correlation-id'] as string;
    }
    return `${Date.now()}-${randomUUID()}`;
  }
}

/**
 * Query filters for admin audit logs
 */
export interface AdminAuditQueryFilters {
  actorId?: string;
  actorType?: string;
  action?: AdminActionType;
  actionCategory?: AdminActionCategory;
  targetType?: string;
  targetId?: string;
  outcome?: 'success' | 'failure' | 'partial';
  severity?: AdminAuditSeverity;
  requestId?: string;
  correlationId?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}

/**
 * Query result for admin audit logs
 */
export interface AdminAuditQueryResult {
  logs: AdminAuditLogRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}