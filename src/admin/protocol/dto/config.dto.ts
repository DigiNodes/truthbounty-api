import { IsString, IsOptional, IsNotEmpty, IsObject } from 'class-validator';
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
