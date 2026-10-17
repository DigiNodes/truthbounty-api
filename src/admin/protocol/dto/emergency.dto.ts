import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MinLength, Matches, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum EmergencyAction {
  SUSPEND_ALL_SERVICES = 'suspend_all_services',
  DISABLE_NOTIFICATIONS = 'disable_notifications',
  PAUSE_ALL_QUEUES = 'pause_all_queues',
  ENABLE_API_THROTTLING = 'enable_api_throttling',
  SUSPEND_INTEGRATIONS = 'suspend_integrations',
  EMERGENCY_SHUTDOWN = 'emergency_shutdown',
}

/**
 * Rollback target kinds that may be subject to atomic, version-safe rollback.
 * Flags are configuration only and cannot grant protocol authority.
 */
export enum RollbackTargetType {
  FEATURE_FLAG = 'feature_flag',
  CONFIGURATION = 'configuration',
}

export class ExecuteEmergencyActionDto {
  @ApiProperty({
    enum: EmergencyAction,
    description: 'Emergency action to execute',
  })
  @IsEnum(EmergencyAction)
  @IsNotEmpty()
  action: EmergencyAction;

  @ApiProperty({ description: 'Reason for emergency action' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({
    description: 'Duration in minutes (for time-bound actions)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationMinutes?: number;
}

/**
 * Request to roll back a feature flag or configuration target.
 * Uses compare-and-swap via `expectedVersion`; stale versions fail closed.
 * Targets are bound to chain/release/deployment/artifact context to prevent
 * cross-boundary rollbacks.
 */
export class RollbackTargetDto {
  @ApiProperty({
    enum: RollbackTargetType,
    description: 'Kind of target being rolled back',
  })
  @IsEnum(RollbackTargetType)
  @IsNotEmpty()
  targetType: RollbackTargetType;

  @ApiProperty({ description: 'Stable identifier of the flag/config target' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9_\-.:]{1,128}$/)
  targetId: string;

  @ApiProperty({
    description: 'Version the client expects to roll back from (optimistic concurrency)',
  })
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @ApiProperty({ description: 'Target version to roll back to' })
  @IsInt()
  @Min(0)
  targetVersion: number;

  @ApiProperty({ description: 'Chain ID the target is bound to' })
  @IsString()
  @IsNotEmpty()
  chainId: string;

  @ApiProperty({ description: 'Release ID the target is bound to' })
  @IsString()
  @IsNotEmpty()
  releaseId: string;

  @ApiProperty({ description: 'Deployment block the target is bound to' })
  @IsInt()
  @Min(0)
  deploymentBlock: number;

  @ApiProperty({
    description: 'Artifact checksum (sha256 hex) the target is bound to',
  })
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  artifactChecksum: string;

  @ApiProperty({ description: 'Reason for the rollback' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({ description: 'Approval reference for audit trail' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_\-.:]{1,128}$/)
  approvalRef?: string;
}

export class EmergencyActionResponse {
  @ApiProperty()
  action: EmergencyAction;

  @ApiProperty()
  success: boolean;

  @ApiProperty()
  timestamp: string;

  @ApiPropertyOptional()
  message?: string;

  @ApiProperty({ type: [Object] })
  affectedServices: string[];
}

export class RollbackResultResponse {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  targetId: string;

  @ApiProperty()
  previousVersion: number;

  @ApiProperty()
  appliedVersion: number;

  @ApiProperty()
  chainId: string;

  @ApiProperty()
  releaseId: string;

  @ApiProperty()
  deploymentBlock: number;

  @ApiProperty()
  artifactChecksum: string;

  @ApiProperty()
  timestamp: string;

  @ApiPropertyOptional()
  message?: string;
}

export class SystemStatusResponse {
  @ApiProperty()
  maintenanceMode: boolean;

  @ApiProperty()
  emergencyActive: boolean;

  @ApiProperty({ type: [String] })
  activeEmergencies: string[];

  @ApiProperty()
  queuesOperational: boolean;

  @ApiProperty()
  notificationsEnabled: boolean;

  @ApiProperty()
  integrationsOperational: boolean;

  @ApiProperty()
  apiThrottlingActive: boolean;

  @ApiProperty()
  uptime: number;

  @ApiProperty()
  environment: string;
}
