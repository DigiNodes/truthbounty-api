import { IsString, IsNotEmpty, IsOptional, IsEnum, IsArray, ValidateNested, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IncidentClassification, IncidentSeverity, IncidentStatus } from '../entities/incident.entity';

export class CreateIncidentDto {
  @ApiProperty({ description: 'Incident title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ description: 'Detailed description' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ enum: IncidentClassification })
  @IsEnum(IncidentClassification)
  @IsNotEmpty()
  classification: IncidentClassification;

  @ApiProperty({ enum: IncidentSeverity })
  @IsEnum(IncidentSeverity)
  @IsNotEmpty()
  severity: IncidentSeverity;

  @ApiPropertyOptional({ description: 'Related entity type (e.g. claim, user)' })
  @IsString()
  @IsOptional()
  relatedEntityType?: string;

  @ApiPropertyOptional({ description: 'Related entity ID' })
  @IsString()
  @IsOptional()
  relatedEntityId?: string;
}

export class UpdateIncidentDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: IncidentClassification })
  @IsEnum(IncidentClassification)
  @IsOptional()
  classification?: IncidentClassification;

  @ApiPropertyOptional({ enum: IncidentSeverity })
  @IsEnum(IncidentSeverity)
  @IsOptional()
  severity?: IncidentSeverity;

  @ApiPropertyOptional({ enum: IncidentStatus })
  @IsEnum(IncidentStatus)
  @IsOptional()
  status?: IncidentStatus;
}

export class AddInvestigationNoteDto {
  @ApiProperty({ description: 'Note content' })
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class ResolveIncidentDto {
  @ApiProperty({ description: 'Resolution summary' })
  @IsString()
  @IsNotEmpty()
  summary: string;

  @ApiProperty({ type: [String], description: 'Actions taken' })
  @IsArray()
  @IsString({ each: true })
  actions: string[];
}

export class PostIncidentReportDto {
  @ApiProperty({ description: 'Root cause analysis' })
  @IsString()
  @IsNotEmpty()
  rootCause: string;

  @ApiProperty({ description: 'Impact description' })
  @IsString()
  @IsNotEmpty()
  impact: string;

  @ApiProperty({ type: [String], description: 'Preventive actions' })
  @IsArray()
  @IsString({ each: true })
  preventiveActions: string[];

  @ApiProperty({ type: [String], description: 'Lessons learned' })
  @IsArray()
  @IsString({ each: true })
  lessonsLearned: string[];
}

export class IncidentQueryDto {
  @ApiPropertyOptional({ enum: IncidentStatus })
  @IsEnum(IncidentStatus)
  @IsOptional()
  status?: IncidentStatus;

  @ApiPropertyOptional({ enum: IncidentSeverity })
  @IsEnum(IncidentSeverity)
  @IsOptional()
  severity?: IncidentSeverity;

  @ApiPropertyOptional({ enum: IncidentClassification })
  @IsEnum(IncidentClassification)
  @IsOptional()
  classification?: IncidentClassification;

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

export class IncidentResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ enum: IncidentClassification })
  classification: IncidentClassification;

  @ApiProperty({ enum: IncidentSeverity })
  severity: IncidentSeverity;

  @ApiProperty({ enum: IncidentStatus })
  status: IncidentStatus;

  @ApiPropertyOptional()
  assignedTo: string | null;

  @ApiPropertyOptional()
  reportedBy: string | null;

  @ApiPropertyOptional()
  relatedEntityType: string | null;

  @ApiPropertyOptional()
  relatedEntityId: string | null;

  @ApiPropertyOptional()
  investigationNotes: any[] | null;

  @ApiPropertyOptional()
  resolution: any | null;

  @ApiPropertyOptional()
  postIncidentReport: any | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional()
  resolvedAt: Date | null;
}
