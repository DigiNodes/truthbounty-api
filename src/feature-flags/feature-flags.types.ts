import { FeatureFlagType } from './entities/feature-flag.entity';

export interface FeatureFlagContext {
  userId?: string;
  roles?: string[];
  environment?: string;
  walletAddress?: string;
}

export interface FeatureFlagRuleSet extends Record<string, unknown> {
  userIds?: string[];
  roles?: string[];
  walletAddresses?: string[];
  startAt?: string;
  endAt?: string;
}

export interface FeatureFlagConfiguration {
  key: string;
  type: FeatureFlagType;
  enabled: boolean;
  rolloutPercentage: number;
  rules: FeatureFlagRuleSet | null;
  environment: string;
  description: string | null;
  isPermanent: boolean;
  metadata: Record<string, unknown> | null;
  expiresAt: Date | null;
}

export interface CreateFeatureFlagInput {
  key: string;
  type: FeatureFlagType;
  enabled: boolean;
  rolloutPercentage?: number;
  rules?: FeatureFlagRuleSet;
  environment?: string;
  description?: string;
  expiresAt?: Date;
  createdBy?: string;
  serverOnly?: boolean;
}

export interface UpdateFeatureFlagInput {
  enabled?: boolean;
  rolloutPercentage?: number;
  rules?: FeatureFlagRuleSet;
  description?: string;
  expiresAt?: Date | null;
  expectedVersion?: number;
  reason?: string;
  serverOnly?: boolean;
}

export interface RollbackFeatureFlagInput {
  targetVersion: number;
  expectedVersion?: number;
  reason?: string;
}

export interface EmergencyDisableFeatureFlagInput {
  expectedVersion?: number;
  reason?: string;
}

export interface FeatureFlagEvaluationResult {
  key: string;
  enabled: boolean;
  reason:
    | 'boolean'
    | 'percentage'
    | 'user'
    | 'role'
    | 'environment'
    | 'time'
    | 'disabled';
}

export interface ConfigurationHistoryEntry {
  id: string;
  key: string;
  value: unknown;
  version: number;
  createdBy?: string;
  changeReason?: string;
  createdAt: Date;
}