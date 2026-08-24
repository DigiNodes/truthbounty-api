import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ServiceType {
  QUEUE = 'queue',
  NOTIFICATION = 'notification',
  WEBHOOK = 'webhook',
  CACHE = 'cache',
  BLOCKCHAIN_INDEXER = 'blockchain_indexer',
  BACKGROUND_PROCESSOR = 'background_processor',
  SCHEDULED_JOB = 'scheduled_job',
}

export enum QueueAction {
  PAUSE = 'pause',
  RESUME = 'resume',
  CLEAR = 'clear',
  RETRY_FAILED = 'retry_failed',
}

export enum ServiceAction {
  SUSPEND = 'suspend',
  RESTORE = 'restore',
  RESTART = 'restart',
  INVALIDATE_CACHE = 'invalidate_cache',
}

export class ControlServiceDto {
  @ApiProperty({ enum: ServiceType, description: 'Type of service to control' })
  @IsEnum(ServiceType)
  @IsNotEmpty()
  serviceType: ServiceType;

  @ApiProperty({
    enum: [...Object.values(QueueAction), ...Object.values(ServiceAction)],
    description: 'Action to perform on the service',
  })
  @IsEnum({ ...QueueAction, ...ServiceAction } as any)
  @IsNotEmpty()
  action: QueueAction | ServiceAction;

  @ApiPropertyOptional({ description: 'Specific queue name (for queue operations)' })
  @IsString()
  @IsOptional()
  queueName?: string;

  @ApiPropertyOptional({ description: 'Reason for the action' })
  @IsString()
  @IsOptional()
  reason?: string;
}

export class ServiceControlResponse {
  @ApiProperty()
  serviceType: ServiceType;

  @ApiProperty()
  action: string;

  @ApiProperty()
  success: boolean;

  @ApiPropertyOptional()
  message?: string;

  @ApiPropertyOptional()
  previousState?: string;

  @ApiPropertyOptional()
  currentState?: string;
}

export class QueueMetricsResponse {
  @ApiProperty()
  name: string;

  @ApiProperty()
  waiting: number;

  @ApiProperty()
  active: number;

  @ApiProperty()
  completed: number;

  @ApiProperty()
  failed: number;

  @ApiProperty()
  delayed: number;

  @ApiProperty()
  paused: boolean;
}

export class AllQueueMetricsResponse {
  @ApiProperty({ type: [QueueMetricsResponse] })
  queues: QueueMetricsResponse[];

  @ApiProperty()
  totalWaiting: number;

  @ApiProperty()
  totalActive: number;

  @ApiProperty()
  totalFailed: number;
}
