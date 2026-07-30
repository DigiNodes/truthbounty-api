import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SetMaintenanceModeDto {
  @ApiProperty({ description: 'Enable or disable maintenance mode' })
  @IsBoolean()
  @IsNotEmpty()
  enabled: boolean;

  @ApiPropertyOptional({ description: 'Reason for maintenance mode change' })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'Scheduled end time (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  scheduledEnd?: string;
}

export class ScheduleMaintenanceDto {
  @ApiProperty({ description: 'Scheduled start time (ISO 8601)' })
  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @ApiPropertyOptional({ description: 'Scheduled end time (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  endTime?: string;

  @ApiProperty({ description: 'Description of maintenance' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({ description: 'Services affected by maintenance' })
  @IsString({ each: true })
  @IsOptional()
  affectedServices?: string[];
}

export class MaintenanceStatusResponse {
  @ApiProperty()
  active: boolean;

  @ApiPropertyOptional()
  reason?: string;

  @ApiPropertyOptional()
  startedAt?: string;

  @ApiPropertyOptional()
  scheduledEnd?: string;

  @ApiProperty({ type: [Object] })
  scheduledMaintenance: Array<{
    id: string;
    description: string;
    startTime: string;
    endTime?: string;
    status: string;
    affectedServices?: string[];
  }>;
}
