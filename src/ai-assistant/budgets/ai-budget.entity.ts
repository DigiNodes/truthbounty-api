import {
  Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn,
} from 'typeorm';
import {
  AiBudgetOperation, AiBudgetOutcome, AiBudgetRule, AiBudgetState, AiBudgetWindow, PaidAiProvider,
} from './ai-budget.types';

@Entity('ai_budget_authority')
export class AiBudgetAuthorityEntity {
  @PrimaryColumn({ type: 'integer' }) readonly id: number;
  @Column({ name: 'policy_version', type: 'uuid', nullable: true }) readonly policyVersion: string | null;
  @Column({ name: 'coverage_start', type: 'timestamptz', nullable: true }) readonly coverageStart: Date | null;
  @Column({ type: 'boolean', default: false }) readonly halted: boolean;
}

@Entity('ai_budget_policies')
export class AiBudgetPolicyEntity {
  @PrimaryGeneratedColumn('uuid') readonly id: string;
  @Column({ type: 'bigint', generated: 'increment' }) readonly revision: string;
  @Column({ type: 'jsonb' }) readonly rules: readonly AiBudgetRule[];
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) readonly createdAt: Date;
  @Column({ name: 'actor_id', type: 'varchar' }) readonly actorId: string;
  @Column({ name: 'change_reference', type: 'varchar' }) readonly changeReference: string;
}

@Entity('ai_budget_prices')
@Index('idx_ai_budget_prices_model_revision', ['provider', 'model', 'revision'])
export class AiBudgetPriceEntity {
  @PrimaryGeneratedColumn('uuid') readonly id: string;
  @Column({ type: 'bigint', generated: 'increment' }) readonly revision: string;
  @Column({ type: 'varchar' }) readonly provider: PaidAiProvider;
  @Column({ type: 'varchar' }) readonly model: string;
  @Column({ name: 'input_nanos', type: 'bigint' }) readonly inputNanos: string;
  @Column({ name: 'output_nanos', type: 'bigint' }) readonly outputNanos: string;
  @Column({ name: 'cached_input_nanos', type: 'bigint' }) readonly cachedInputNanos: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) readonly createdAt: Date;
  @Column({ name: 'actor_id', type: 'varchar' }) readonly actorId: string;
  @Column({ name: 'change_reference', type: 'varchar' }) readonly changeReference: string;
}

@Entity('ai_budget_attempts')
@Index('idx_ai_budget_attempt_user_time', ['userId', 'createdAt'])
@Index('idx_ai_budget_attempt_provider_time', ['provider', 'createdAt'])
@Index('idx_ai_budget_attempt_time', ['createdAt'])
export class AiBudgetAttemptEntity {
  @PrimaryGeneratedColumn('uuid') readonly id: string;
  @Column({ name: 'user_id', type: 'varchar' }) readonly userId: string;
  @Column({ type: 'varchar' }) readonly provider: PaidAiProvider;
  @Column({ type: 'varchar' }) readonly model: string;
  @Column({ type: 'varchar' }) readonly operation: AiBudgetOperation;
  @Column({ name: 'price_id', type: 'uuid' }) readonly priceId: string;
  @Column({ name: 'policy_id', type: 'uuid' }) readonly policyId: string;
  @Column({ name: 'max_input_tokens', type: 'bigint' }) readonly maxInputTokens: string;
  @Column({ name: 'max_output_tokens', type: 'bigint' }) readonly maxOutputTokens: string;
  @Column({ name: 'reserved_tokens', type: 'bigint' }) readonly reservedTokens: string;
  @Column({ name: 'reserved_nanos', type: 'bigint' }) readonly reservedNanos: string;
  @Column({ name: 'charged_tokens', type: 'bigint' }) readonly chargedTokens: string;
  @Column({ name: 'charged_nanos', type: 'bigint' }) readonly chargedNanos: string;
  @Column({ name: 'actual_input_tokens', type: 'bigint', nullable: true }) readonly actualInputTokens: string | null;
  @Column({ name: 'actual_output_tokens', type: 'bigint', nullable: true }) readonly actualOutputTokens: string | null;
  @Column({ type: 'varchar', default: 'held' }) readonly state: AiBudgetState;
  @Column({ type: 'varchar', nullable: true }) readonly outcome: AiBudgetOutcome | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) readonly createdAt: Date;
  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true }) readonly settledAt: Date | null;
}

@Entity('ai_budget_overrides')
@Index('idx_ai_budget_override_window', ['userId', 'window', 'windowStart'])
export class AiBudgetOverrideEntity {
  @PrimaryGeneratedColumn('uuid') readonly id: string;
  @Column({ name: 'user_id', type: 'varchar' }) readonly userId: string;
  @Column({ type: 'varchar' }) readonly window: AiBudgetWindow;
  @Column({ name: 'window_start', type: 'timestamptz' }) readonly windowStart: Date;
  @Column({ name: 'extra_tokens', type: 'bigint' }) readonly extraTokens: string;
  @Column({ name: 'extra_nanos', type: 'bigint' }) readonly extraNanos: string;
  @Column({ name: 'expires_at', type: 'timestamptz' }) readonly expiresAt: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true }) readonly revokedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) readonly createdAt: Date;
  @Column({ name: 'actor_id', type: 'varchar' }) readonly actorId: string;
  @Column({ name: 'change_reference', type: 'varchar' }) readonly changeReference: string;
}
