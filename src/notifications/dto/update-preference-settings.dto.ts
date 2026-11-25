import {
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { QuietHoursDto } from './quiet-hours.dto';
import { DigestPreferencesDto } from './digest-preferences.dto';
import { WebhookConfigDto } from './webhook-config.dto';
import { PushConfigDto } from './push-config.dto';
import { IsValidChannelPreferences } from '../validators/is-valid-channel-preferences.validator';
import { IsValidCategorySubscriptions } from '../validators/is-valid-category-subscriptions.validator';

export class UpdatePreferenceSettingsDto {
  @IsOptional()
  @IsValidChannelPreferences()
  channels?: Record<string, boolean> | string[];

  @IsOptional()
  @IsValidCategorySubscriptions()
  categorySubscriptions?: Record<string, boolean>;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DigestPreferencesDto)
  digestPreferences?: DigestPreferencesDto;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebhookConfigDto)
  webhookConfig?: WebhookConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PushConfigDto)
  pushConfig?: PushConfigDto;
}
