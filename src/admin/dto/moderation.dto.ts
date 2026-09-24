import { IsString, IsNotEmpty, IsOptional, IsEnum, IsArray, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReportType, ReportStatus, ReportPriority } from '../entities/moderation-report.entity';

export class CreateReportDto {
  @ApiProperty({ enum: ReportType })
  @IsEnum(ReportType)
  @IsNotEmpty()
  type: ReportType;

  @ApiProperty({ description: 'Report title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Detailed description' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({ description: 'Who is submitting the report' })
  @IsString()
  @IsOptional()
  reportedBy?: string;

  @ApiPropertyOptional({ description: 'User being reported (if applicable)' })
  @IsString()
  @IsOptional()
  reportedUser?: string;

  @ApiPropertyOptional({ description: 'ID of the target entity' })
  @IsString()
  @IsOptional()
  targetId?: string;

  @ApiPropertyOptional({ description: 'Type of the target entity' })
  @IsString()
  @IsOptional()
  targetType?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  evidence?: Record<string, any>;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}

export class UpdateReportDto {
  @ApiPropertyOptional({ enum: ReportStatus })
  @IsEnum(ReportStatus)
  @IsOptional()
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportPriority })
  @IsEnum(ReportPriority)
  @IsOptional()
  priority?: ReportPriority;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;
}

export class ResolveReportDto {
  @ApiProperty({ description: 'Action taken' })
  @IsString()
  @IsNotEmpty()
  action: string;

  @ApiProperty({ description: 'Resolution notes' })
  @IsString()
  @IsNotEmpty()
  notes: string;
}

export class ModerationQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus })
  @IsEnum(ReportStatus)
  @IsOptional()
  status?: ReportStatus;

  @ApiPropertyOptional({ enum: ReportType })
  @IsEnum(ReportType)
  @IsOptional()
  type?: ReportType;

  @ApiPropertyOptional({ enum: ReportPriority })
  @IsEnum(ReportPriority)
  @IsOptional()
  priority?: ReportPriority;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  fromDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  toDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  page?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  limit?: string;
}

export class AssignDto {
  @ApiProperty({ description: 'Admin ID to assign' })
  @IsString()
  @IsNotEmpty()
  assigneeId: string;
}

export class ModerationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ReportType })
  type: ReportType;

  @ApiProperty({ enum: ReportStatus })
  status: ReportStatus;

  @ApiProperty({ enum: ReportPriority })
  priority: ReportPriority;

  @ApiProperty()
  title: string;

  @ApiProperty()
  description: string;

  @ApiPropertyOptional()
  reportedBy: string | null;

  @ApiPropertyOptional()
  reportedUser: string | null;

  @ApiPropertyOptional()
  targetId: string | null;

  @ApiPropertyOptional()
  targetType: string | null;

  @ApiPropertyOptional()
  assignedTo: string | null;

  @ApiPropertyOptional()
  evidence: any[] | null;

  @ApiPropertyOptional()
  resolution: any | null;

  @ApiPropertyOptional()
  metadata: Record<string, any> | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional()
  resolvedAt: Date | null;
}
