import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsArray,
  IsDateString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  NotificationType,
  DeliveryChannel,
  NotificationPriority,
} from '../enums/notification-type.enum';

export class CreateNotificationDto {
  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty()
  @IsUUID()
  userId: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  walletAddress?: string;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  body: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  data?: Record<string, any>;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsEnum(NotificationPriority)
  @IsOptional()
  priority?: NotificationPriority;

  @ApiPropertyOptional({ enum: DeliveryChannel, isArray: true })
  @IsArray()
  @IsEnum(DeliveryChannel, { each: true })
  @IsOptional()
  channels?: DeliveryChannel[];

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  templateName?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  templateVariables?: Record<string, string>;
}
