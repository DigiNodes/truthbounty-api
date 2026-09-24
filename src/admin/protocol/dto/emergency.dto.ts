import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum EmergencyAction {
  SUSPEND_ALL_SERVICES = 'suspend_all_services',
  DISABLE_NOTIFICATIONS = 'disable_notifications',
  PAUSE_ALL_QUEUES = 'pause_all_queues',
  ENABLE_API_THROTTLING = 'enable_api_throttling',
  SUSPEND_INTEGRATIONS = 'suspend_integrations',
  EMERGENCY_SHUTDOWN = 'emergency_shutdown',
}

export class ExecuteEmergencyActionDto {
  @ApiProperty({ enum: EmergencyAction, description: 'Emergency action to execute' })
  @IsEnum(EmergencyAction)
  @IsNotEmpty()
  action: EmergencyAction;

  @ApiProperty({ description: 'Reason for emergency action' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ description: 'Duration in minutes (for time-bound actions)' })
  @IsOptional()
  durationMinutes?: number;
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
