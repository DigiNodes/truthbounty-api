import { IsOptional, IsBoolean, IsArray, IsEnum, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DeliveryChannel, NotificationCategory } from '../interfaces/notification.types';

export class EmailPreferencesDto {
  @IsOptional()
  @IsBoolean()
  digestEnabled?: boolean;

  @IsOptional()
  @IsEnum(['daily', 'weekly', 'never'])
  digestFrequency?: 'daily' | 'weekly' | 'never';

  @IsOptional()
  @IsString()
  emailAddress?: string;
}

export class UpdatePreferencesDto {
  @IsOptional()
  @IsArray()
  @IsEnum(DeliveryChannel, { each: true })
  enabledChannels?: DeliveryChannel[];

  @IsOptional()
  @ValidateNested()
  @Type(() => EmailPreferencesDto)
  emailPreferences?: EmailPreferencesDto;

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
  categorySettings?: Record<NotificationCategory, boolean>;
}