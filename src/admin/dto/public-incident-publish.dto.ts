import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PUBLIC_INCIDENT_AFFECTED_COMPONENTS,
  PUBLIC_INCIDENT_IMPACTS,
  PUBLIC_INCIDENT_STATUSES,
  PublicIncidentComponent,
  PublicIncidentImpact,
  PublicIncidentLinkDto,
  PublicIncidentStatus,
} from '../../health/public-incidents/public-incidents.dto';

export class PublishIncidentProjectionDto {
  @ApiProperty({ description: 'Public incident title', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_STATUSES,
    description: 'Current public incident status',
  })
  @IsEnum(PUBLIC_INCIDENT_STATUSES)
  status: PublicIncidentStatus;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_IMPACTS,
    description: 'User-facing impact level',
  })
  @IsEnum(PUBLIC_INCIDENT_IMPACTS)
  impact: PublicIncidentImpact;

  @ApiProperty({
    enum: PUBLIC_INCIDENT_AFFECTED_COMPONENTS,
    isArray: true,
    description: 'Affected public components',
  })
  @IsArray()
  affectedComponents: PublicIncidentComponent[];

  @ApiProperty({ description: 'Sanitized Markdown narrative description' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({
    description: 'Sanitized Markdown mitigation summary',
  })
  @IsOptional()
  @IsString()
  mitigation?: string;

  @ApiPropertyOptional({
    type: [PublicIncidentLinkDto],
    description: 'Approved external links (post-mortems, public writeups)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublicIncidentLinkDto)
  postIncidentLinks?: PublicIncidentLinkDto[];

  @ApiPropertyOptional({
    description: 'Optional update message to append to public publication history',
  })
  @IsOptional()
  @IsString()
  updateMessage?: string;

  @ApiPropertyOptional({
    description: 'Slug for public URL',
  })
  @IsOptional()
  @IsString()
  slug?: string;
}
