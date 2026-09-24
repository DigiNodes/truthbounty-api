import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  IsEmail,
  IsUrl,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DeliveryChannel,
  NotificationFrequency,
} from '../enums/notification-type.enum';

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ enum: DeliveryChannel, isArray: true })
  @IsArray()
  @IsEnum(DeliveryChannel, { each: true })
  @IsOptional()
  enabledChannels?: DeliveryChannel[];

  @ApiPropertyOptional({ enum: NotificationFrequency })
  @IsEnum(NotificationFrequency)
  @IsOptional()
  frequency?: NotificationFrequency;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  quietHoursStart?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  quietHoursEnd?: string;

  @ApiPropertyOptional({ isArray: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  subscribedCategories?: string[];

  @ApiPropertyOptional({ isArray: true })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  unsubscribedCategories?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  digestEnabled?: boolean;

  @ApiPropertyOptional({ enum: NotificationFrequency })
  @IsEnum(NotificationFrequency)
  @IsOptional()
  digestFrequency?: NotificationFrequency;

  @ApiPropertyOptional()
  @IsEmail()
  @IsOptional()
  emailAddress?: string;

  @ApiPropertyOptional()
  @IsUrl()
  @IsOptional()
  webhookUrl?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  pushToken?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  notificationsEnabled?: boolean;
}
