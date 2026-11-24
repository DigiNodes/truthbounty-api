import { IsString, IsOptional, IsNotEmpty, IsObject, IsInt, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProtocolConfigDto {
  @ApiProperty({ description: 'Configuration key' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ description: 'Configuration value (JSON)' })
  @IsObject()
  @IsNotEmpty()
  value: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Environment scope' })
  @IsString()
  @IsOptional()
  environment?: string;

  @ApiPropertyOptional({ description: 'Reason for change' })
  @IsString()
  @IsOptional()
  changeReason?: string;
}

export class ProtocolConfigResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  key: string;

  @ApiProperty()
  value: unknown;

  @ApiProperty()
  environment: string;

  @ApiProperty()
  version: number;

  @ApiPropertyOptional()
  createdBy?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class RollbackChainContextDto {
  @ApiProperty()
  @IsInt()
  chainId: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  releaseId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  deploymentBlock: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  artifactChecksum: string;
}

/**
 * Rollback target descriptor. The target version is mandatory and is
 * validated against the current version using compare-and-swap semantics.
 */
export class RollbackTargetDto {
  @ApiProperty({ description: 'Target configuration key' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ description: 'Target version to roll back to' })
  @IsInt()
  @Min(1)
  targetVersion: number;

  @ApiProperty({
    description:
      'Current version the caller observed (optimistic concurrency token)',
  })
  @IsInt()
  @Min(1)
  expectedVersion: number;

  @ApiPropertyOptional({ description: 'Environment scope' })
  @IsString()
  @IsOptional()
  environment?: string;

  @ApiProperty({ description: 'Reason for rollback' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ description: 'Chain context for audit binding' })
  @IsOptional()
  @ValidateNested()
  chainContext?: RollbackChainContextDto;
}

export class RollbackResultResponse {
  @ApiProperty()
  key: string;

  @ApiProperty()
  fromVersion: number;

  @ApiProperty()
  toVersion: number;

  @ApiProperty()
  newVersion: number;

  @ApiProperty()
  auditId: string;

  @ApiProperty()
  timestamp: string;
}

export class OperationalStatsResponse {
  @ApiProperty()
  totalUsers: number;

  @ApiProperty()
  totalClaims: number;

  @ApiProperty()
  totalDisputes: number;

  @ApiProperty()
  totalAdmins: number;

  @ApiProperty()
  activeAdmins: number;

  @ApiProperty()
  pendingClaims: number;

  @ApiProperty()
  finalizedClaims: number;

  @ApiProperty()
  auditLogCount: number;

  @ApiProperty()
  queueMetrics: {
    totalWaiting: number;
    totalActive: number;
    totalFailed: number;
    totalCompleted: number;
  };

  @ApiProperty()
  systemUptime: number;

  @ApiProperty()
  environment: string;

  @ApiProperty()
  timestamp: string;
}
