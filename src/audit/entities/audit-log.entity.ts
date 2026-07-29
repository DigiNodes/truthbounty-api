import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../entities/user.entity';

export enum AuditActionType {
  CLAIM_CREATED = 'CLAIM_CREATED',
  CLAIM_UPDATED = 'CLAIM_UPDATED',
  CLAIM_RESOLVED = 'CLAIM_RESOLVED',
  CLAIM_FINALIZED = 'CLAIM_FINALIZED',
  EVIDENCE_SUBMITTED = 'EVIDENCE_SUBMITTED',
  EVIDENCE_UPDATED = 'EVIDENCE_UPDATED',
  EVIDENCE_FLAGGED = 'EVIDENCE_FLAGGED',
  EVIDENCE_VERIFIED = 'EVIDENCE_VERIFIED',
  VERIFICATION_COMPLETED = 'VERIFICATION_COMPLETED',
  REWARD_CALCULATED = 'REWARD_CALCULATED',
  REWARD_DISTRIBUTED = 'REWARD_DISTRIBUTED',
  REWARD_CLAIMED = 'REWARD_CLAIMED',
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_DELETED = 'USER_DELETED',
  WALLET_LINKED = 'WALLET_LINKED',
  WALLET_UNLINKED = 'WALLET_UNLINKED',
  VERIFICATION_INITIATED = 'VERIFICATION_INITIATED',
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  TOKEN_REFRESHED = 'TOKEN_REFRESHED',
  PASSWORD_RESET_REQUESTED = 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED = 'PASSWORD_RESET_COMPLETED',
  PERMISSION_CHANGED = 'PERMISSION_CHANGED',
  ROLE_ASSIGNED = 'ROLE_ASSIGNED',
  ROLE_REVOKED = 'ROLE_REVOKED',
  ADMIN_ACTION = 'ADMIN_ACTION',
  MODERATOR_ACTION = 'MODERATOR_ACTION',
  GOVERNANCE_PROPOSAL_CREATED = 'GOVERNANCE_PROPOSAL_CREATED',
  GOVERNANCE_VOTE_CAST = 'GOVERNANCE_VOTE_CAST',
  GOVERNANCE_PROPOSAL_EXECUTED = 'GOVERNANCE_PROPOSAL_EXECUTED',
  GOVERNANCE_PROPOSAL_CANCELLED = 'GOVERNANCE_PROPOSAL_CANCELLED',
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  DISPUTE_ESCALATED = 'DISPUTE_ESCALATED',
  REPUTATION_CHANGED = 'REPUTATION_CHANGED',
  CONFIGURATION_CHANGED = 'CONFIGURATION_CHANGED',
  API_ACCESS = 'API_ACCESS',
  NOTIFICATION_SENT = 'NOTIFICATION_SENT',
  NOTIFICATION_FAILED = 'NOTIFICATION_FAILED',
  AI_ASSISTANT_INTERACTION = 'AI_ASSISTANT_INTERACTION',
  DATA_EXPORT = 'DATA_EXPORT',
  LEGAL_HOLD_APPLIED = 'LEGAL_HOLD_APPLIED',
  LEGAL_HOLD_REMOVED = 'LEGAL_HOLD_REMOVED',
  RETENTION_EXECUTED = 'RETENTION_EXECUTED',
  ARCHIVAL_COMPLETED = 'ARCHIVAL_COMPLETED',
}

export enum AuditEntityType {
  CLAIM = 'CLAIM',
  EVIDENCE = 'EVIDENCE',
  REWARD = 'REWARD',
  USER = 'USER',
  WALLET = 'WALLET',
  DISPUTE = 'DISPUTE',
  PROPOSAL = 'PROPOSAL',
  VOTE = 'VOTE',
  MODERATOR = 'MODERATOR',
  ADMIN = 'ADMIN',
  CONFIGURATION = 'CONFIGURATION',
  NOTIFICATION = 'NOTIFICATION',
  AI_INTERACTION = 'AI_INTERACTION',
  PERMISSION = 'PERMISSION',
  ROLE = 'ROLE',
  AUDIT_LOG = 'AUDIT_LOG',
  REPORT = 'REPORT',
}

export enum AuditSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum AuditCategory {
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  ADMINISTRATIVE = 'ADMINISTRATIVE',
  MODERATION = 'MODERATION',
  GOVERNANCE = 'GOVERNANCE',
  API_ACCESS = 'API_ACCESS',
  NOTIFICATION = 'NOTIFICATION',
  AI_ASSISTANT = 'AI_ASSISTANT',
  CONFIGURATION = 'CONFIGURATION',
  SECURITY = 'SECURITY',
  COMPLIANCE = 'COMPLIANCE',
  DATA_MANAGEMENT = 'DATA_MANAGEMENT',
  OPERATIONS = 'OPERATIONS',
}

@Entity('audit_logs')
@Index(['userId'])
@Index(['entityType'])
@Index(['actionType'])
@Index(['createdAt'])
@Index(['entityId'])
@Index(['severity'])
@Index(['category'])
@Index(['source'])
@Index(['requestId'])
@Index(['userId', 'createdAt'])
@Index(['actionType', 'createdAt'])
@Index(['category', 'createdAt'])
@Index(['severity', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  eventId: string;

  @Column({
    type: 'varchar',
    enum: AuditActionType,
  })
  actionType: AuditActionType;

  @Column({
    type: 'varchar',
    enum: AuditEntityType,
  })
  entityType: AuditEntityType;

  @Column()
  entityId: string;

  @Column({ nullable: true })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user: User | null;

  @Column({ nullable: true })
  walletAddress: string | null;

  @Column({ type: 'varchar', default: 'LOW', enum: AuditSeverity })
  severity: AuditSeverity;

  @Column({ type: 'varchar', default: 'OPERATIONS', enum: AuditCategory })
  category: AuditCategory;

  @Column({ nullable: true })
  source: string | null;

  @Column({ nullable: true })
  requestId: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'json', nullable: true })
  beforeState: Record<string, any> | null;

  @Column({ type: 'json', nullable: true })
  afterState: Record<string, any> | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ nullable: true })
  ipAddress: string | null;

  @Column({ nullable: true })
  userAgent: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  correlationId: string;

  @Column({ type: 'datetime', nullable: true })
  retentionUntil: Date | null;
}
