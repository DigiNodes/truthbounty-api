import {
  IsString,
  IsBoolean,
  IsOptional,
  IsEnum,
  IsJSON,
  IsEmail,
  IsUrl,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  NotificationType,
  NotificationChannel,
} from '../entities/notification.entity';

export class CreateNotificationDto {
  @IsString()
  recipientId: string;

  @IsEnum(NotificationType)
  type: NotificationType;

  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsOptional()
  metadata?: Record<string, any>;
}

export class UpdatePreferencesDto {
  @IsOptional()
  enabledChannels?: Record<NotificationChannel, boolean>;

  @IsOptional()
  enabledCategories?: Record<NotificationType, boolean>;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsEmail()
  emailAddress?: string;

  @IsOptional()
  @IsBoolean()
  governanceAlerts?: boolean;

  @IsOptional()
  @IsBoolean()
  stakingAlerts?: boolean;

  @IsOptional()
  @IsBoolean()
  rewardNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  securityAlerts?: boolean;

  @IsOptional()
  webhookConfig?: {
    url: string;
    secret: string;
    enabled: boolean;
  };

  @IsOptional()
  pushSubscription?: {
    endpoint: string;
    keys: Record<string, string>;
  };
}

export class NotificationQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @IsOptional()
  @IsBoolean()
  read?: boolean;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;
}

export class MarkAsReadDto {
  @IsString()
  notificationId: string;
}

export class ProtocolEventDto {
  @IsString()
  source: string; // blockchain-indexer, governance-service, etc.
  @IsString()
  eventType: string;
  @IsString()
  recipientId: string;
  @IsJSON()
  payload: Record<string, any>;
  @IsOptional()
  timestamp?: Date;
}