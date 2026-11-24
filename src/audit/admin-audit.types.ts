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

export type AdminAuditOutcome =
  'attempted' | 'success' | 'failure' | 'partial' | 'rolled_back' | 'unknown';
export type AdminAuthoritySource = 'rbac' | 'policy' | 'service' | 'chain';

export interface AdminAuditChainContext {
  chainId: number;
  releaseId: string;
  deploymentBlock: string;
  artifactChecksum: string;
}

/** Only opaque references and reviewed codes belong in these fields, never payloads. */
export interface AdminAuditLogInput {
  actorId: string;
  actorType: 'user' | 'service' | 'system';
  action: AdminActionType;
  actionCategory: AdminActionCategory;
  targetType: string;
  targetId: string;
  capability: string;
  authoritySource: AdminAuthoritySource;
  authorityReference: string;
  requestReference: string;
  resultReference?: string;
  correlationId: string;
  outcome: AdminAuditOutcome;
  severity?: AdminAuditSeverity;
  chainContext?: AdminAuditChainContext;
}
