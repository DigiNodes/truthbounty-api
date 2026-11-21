import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index,
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

/** Durable append-only usage survives conversation deletion and provider errors. */
@Entity('ai_usage_logs')
@Index(['userId', 'createdAt'])
@Index(['provider', 'createdAt'])
@Index(['status'])
@Index('uq_ai_usage_budget_attempt', ['budgetAttemptId'], { unique: true })
export class AiUsageLog {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', nullable: true }) @Index() userId: string | null;
  @Column({ type: 'varchar', nullable: true }) conversationId: string | null;
  @Column({ type: 'varchar', nullable: true }) messageId: string | null;
  @Column() provider: string;
  @Column({ type: 'varchar', nullable: true }) model: string | null;
  @Column({ type: 'varchar' }) endpoint: AiUsageEndpoint;
  @Column({ type: 'varchar' }) status: AiUsageStatus;

  // PostgreSQL returns bigint strings. Preserve unknown actuals as NULL and
  // counts beyond int32/Number precision without an unsafe numeric transformer.
  @Column({ type: 'bigint', nullable: true }) promptTokens: number | string | null;
  @Column({ type: 'bigint', nullable: true }) completionTokens: number | string | null;
  @Column({ type: 'bigint', nullable: true }) totalTokens: number | string | null;
  @Column({ type: 'int', default: 0 }) latencyMs: number;
  @Column({ type: 'boolean', default: false }) cacheHit: boolean;
  @Column({ type: 'varchar', nullable: true }) errorCode: string | null;
  @Column({ type: 'uuid', nullable: true }) budgetAttemptId: string | null;
  @Column({ type: 'uuid', nullable: true }) priceVersion: string | null;
  @Column({ type: 'bigint', nullable: true }) chargedTokens: string | null;
  @Column({ type: 'bigint', nullable: true }) costUsdNanos: string | null;
  @Column({ type: 'boolean', default: false }) usageComplete: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
