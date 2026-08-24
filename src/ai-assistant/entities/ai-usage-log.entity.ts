import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AiUsageEndpoint {
  CHAT = 'chat',
  STREAM = 'stream',
  KNOWLEDGE_BASE = 'knowledge_base',
  ANALYTICS = 'analytics',
}

export enum AiUsageStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  RATE_LIMITED = 'rate_limited',
  SAFETY_BLOCKED = 'safety_blocked',
}

/**
 * Append-only usage/audit log, intentionally separate from Message: it must
 * survive conversation deletion, and it also records calls that never
 * produced an assistant Message (safety-blocked, rate-limited, provider errors).
 */
@Entity('ai_usage_logs')
@Index(['userId', 'createdAt'])
@Index(['provider', 'createdAt'])
@Index(['status'])
export class AiUsageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ nullable: true })
  conversationId: string;

  @Column({ nullable: true })
  messageId: string;

  @Column()
  provider: string;

  @Column({ nullable: true })
  model: string;

  @Column({ type: 'varchar' })
  endpoint: AiUsageEndpoint;

  @Column({ type: 'varchar' })
  status: AiUsageStatus;

  @Column({ type: 'int', default: 0 })
  promptTokens: number;

  @Column({ type: 'int', default: 0 })
  completionTokens: number;

  @Column({ type: 'int', default: 0 })
  totalTokens: number;

  @Column({ type: 'int', default: 0 })
  latencyMs: number;

  @Column({ type: 'boolean', default: false })
  cacheHit: boolean;

  @Column({ nullable: true })
  errorCode: string;

  @CreateDateColumn()
  createdAt: Date;
}
