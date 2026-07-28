import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsDateString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum ReportType {
  ADMIN_ACTIVITY = 'ADMIN_ACTIVITY',
  MODERATION_ACTIONS = 'MODERATION_ACTIONS',
  GOVERNANCE_ACTIONS = 'GOVERNANCE_ACTIONS',
  AUTHENTICATION_HISTORY = 'AUTHENTICATION_HISTORY',
  FAILED_ACCESS_ATTEMPTS = 'FAILED_ACCESS_ATTEMPTS',
  SECURITY_EVENTS = 'SECURITY_EVENTS',
  PROTOCOL_OPERATIONS = 'PROTOCOL_OPERATIONS',
  USER_ACTIVITY = 'USER_ACTIVITY',
}

export enum ReportFormat {
  JSON = 'JSON',
  CSV = 'CSV',
}

export class GenerateReportDto {
  @ApiProperty({ enum: ReportType })
  @IsEnum(ReportType)
  reportType: ReportType;

  @ApiPropertyOptional({ enum: ReportFormat, default: ReportFormat.JSON })
  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;
}

export class ReportResponse {
  @ApiProperty()
  reportType: ReportType;

  @ApiProperty()
  generatedAt: string;

  @ApiProperty()
  period: { start: string; end: string };

  @ApiProperty()
  generatedBy: string;

  @ApiProperty()
  totalEvents: number;

  @ApiProperty()
  data: any;

  @ApiProperty({ required: false })
  exportUrl?: string;
}
