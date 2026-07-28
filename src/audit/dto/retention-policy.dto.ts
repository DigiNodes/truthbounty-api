import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, IsEnum, IsString, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { AuditEventType } from '../entities/audit-log.entity';

export class RetentionPolicyConfig {
  @ApiProperty({ default: 365 })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  defaultRetentionDays: number;

  @ApiPropertyOptional()
  @IsOptional()
  overrides?: { eventType: AuditEventType; days: number }[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  archiveBeforeDelete?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  exportBeforeDelete?: boolean;
}

export class LegalHoldDto {
  @ApiProperty()
  @IsString()
  entityId: string;

  @ApiProperty()
  @IsString()
  reason: string;

  @ApiProperty()
  @IsString()
  initiatedBy: string;
}

export class RetentionStatusDto {
  @ApiProperty()
  totalRecords: number;

  @ApiProperty()
  archivedRecords: number;

  @ApiProperty()
  legalHoldRecords: number;

  @ApiProperty()
  pendingCleanup: number;

  @ApiProperty()
  estimatedSizeBytes: number;

  @ApiProperty()
  retentionEndDate: string;
}
