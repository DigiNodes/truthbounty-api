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
}

export enum AuditEntityType {
  CLAIM = 'CLAIM',
  EVIDENCE = 'EVIDENCE',
  REWARD = 'REWARD',
  USER = 'USER',
  WALLET = 'WALLET',
}

@Entity('audit_logs')
@Index(['userId'])
@Index(['entityType'])
@Index(['actionType'])
@Index(['createdAt'])
@Index(['entityId'])
@Index(['userId', 'createdAt'])
@Index(['actionType', 'createdAt'])
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

  @CreateDateColumn()
  createdAt: Date;

  @Column({ nullable: true })
  correlationId: string;
}
