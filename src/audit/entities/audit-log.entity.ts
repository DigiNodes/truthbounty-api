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
  // Claim actions
  CLAIM_CREATED = 'CLAIM_CREATED',
  CLAIM_UPDATED = 'CLAIM_UPDATED',
  CLAIM_RESOLVED = 'CLAIM_RESOLVED',
  CLAIM_FINALIZED = 'CLAIM_FINALIZED',

  // Evidence/Verification actions
  EVIDENCE_SUBMITTED = 'EVIDENCE_SUBMITTED',
  EVIDENCE_UPDATED = 'EVIDENCE_UPDATED',
  EVIDENCE_FLAGGED = 'EVIDENCE_FLAGGED',
  EVIDENCE_VERIFIED = 'EVIDENCE_VERIFIED',
  VERIFICATION_COMPLETED = 'VERIFICATION_COMPLETED',

  // Reward actions
  REWARD_CALCULATED = 'REWARD_CALCULATED',
  REWARD_DISTRIBUTED = 'REWARD_DISTRIBUTED',
  REWARD_CLAIMED = 'REWARD_CLAIMED',

  // User actions
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  WALLET_UNLINKED = 'WALLET_UNLINKED',
  VERIFICATION_INITIATED = 'VERIFICATION_INITIATED',

  // Authentication & Authorization
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  CHALLENGE_REQUESTED = 'CHALLENGE_REQUESTED',
  TOKEN_REFRESHED = 'TOKEN_REFRESHED',
  TOKEN_REVOKED = 'TOKEN_REVOKED',
  AUTHORIZATION_FAILED = 'AUTHORIZATION_FAILED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  // Administrative actions
  ADMIN_ACTION = 'ADMIN_ACTION',
  USER_BANNED = 'USER_BANNED',
  USER_UNBANNED = 'USER_UNBANNED',
  USER_ROLE_CHANGED = 'USER_ROLE_CHANGED',
  SYSTEM_CONFIG_CHANGED = 'SYSTEM_CONFIG_CHANGED',
  FEATURE_FLAG_CHANGED = 'FEATURE_FLAG_CHANGED',

  // Moderator actions
  MODERATOR_ACTION = 'MODERATOR_ACTION',
  EVIDENCE_HIDDEN = 'EVIDENCE_HIDDEN',
  EVIDENCE_RESTORED = 'EVIDENCE_RESTORED',
  FLAG_REVIEWED = 'FLAG_REVIEWED',

  // Governance actions
  PROPOSAL_CREATED = 'PROPOSAL_CREATED',
  PROPOSAL_UPDATED = 'PROPOSAL_UPDATED',
  VOTE_CAST = 'VOTE_CAST',
  VOTE_CHANGED = 'VOTE_CHANGED',
  PROPOSAL_EXECUTED = 'PROPOSAL_EXECUTED',
  PROPOSAL_CANCELLED = 'PROPOSAL_CANCELLED',

  // Dispute actions
  DISPUTE_CREATED = 'DISPUTE_CREATED',
  DISPUTE_UPDATED = 'DISPUTE_UPDATED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  DISPUTE_ESCALATED = 'DISPUTE_ESCALATED',

  // Staking actions
  STAKE_DEPOSITED = 'STAKE_DEPOSITED',
  STAKE_WITHDRAWN = 'STAKE_WITHDRAWN',
  STAKE_SLASHED = 'STAKE_SLASHED',

  // Security events
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTEGRITY_VIOLATION = 'INTEGRITY_VIOLATION',
  ACCESS_AUDITED = 'ACCESS_AUDITED',
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
  STAKE = 'STAKE',
  CONFIG = 'CONFIG',
  AUDIT_LOG = 'AUDIT_LOG',
  SYSTEM = 'SYSTEM',
}

export enum AuditEventType {
  AUTHENTICATION = 'AUTHENTICATION',
  AUTHORIZATION = 'AUTHORIZATION',
  API_REQUEST = 'API_REQUEST',
  ADMINISTRATIVE = 'ADMINISTRATIVE',
  MODERATOR = 'MODERATOR',
  GOVERNANCE = 'GOVERNANCE',
  VERIFICATION = 'VERIFICATION',
  DISPUTE = 'DISPUTE',
  REWARD = 'REWARD',
  CONFIG_CHANGE = 'CONFIG_CHANGE',
  SECURITY = 'SECURITY',
  STAKING = 'STAKING',
}

export enum AuditSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

@Entity('audit_logs')
@Index(['userId'])
@Index(['entityType'])
@Index(['actionType'])
@Index(['createdAt'])
@Index(['entityId'])
@Index(['userId', 'createdAt'])
@Index(['actionType', 'createdAt'])
@Index(['eventType'])
@Index(['severity'])
@Index(['actorRole'])
@Index(['archived'])
@Index(['retentionUntil'])
@Index(['integrityHash'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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
  walletAddress: string;

  @Column({ type: 'varchar', nullable: true })
  actorRole: string;

  @Column({ type: 'varchar', nullable: true })
  eventType: AuditEventType;

  @Column({ type: 'varchar', nullable: true })
  resourceType: string;

  @Column({
    type: 'varchar',
    default: AuditSeverity.INFO,
  })
  severity: AuditSeverity;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'json', nullable: true })
  beforeState: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  afterState: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ nullable: true })
  ipAddress: string;

  @Column({ nullable: true })
  userAgent: string;

  @Column({ nullable: true })
  requestId: string;

  @Column({ nullable: true })
  correlationId: string;

  @Column({ type: 'varchar', nullable: true })
  integrityHash: string;

  @Column({ default: false })
  archived: boolean;

  @Column({ type: 'datetime', nullable: true })
  retentionUntil: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
