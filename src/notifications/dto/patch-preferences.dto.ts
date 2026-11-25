import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Allowed per-channel toggles. Unknown keys are rejected by the global pipe. */
export class ChannelPreferencesDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() in_app?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() email?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() push?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() webhook?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() websocket?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sms?: boolean;
}

export class QuietHoursDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() startTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() endTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() timezone?: string;
}

export class DigestPreferencesDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() frequency?: 'DAILY' | 'WEEKLY';
  @ApiPropertyOptional() @IsOptional() @IsString() deliveryTime?: string;
}

export class PushConfigDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) deviceTokens?: string[];
}

/**
 * Patch contract for ordinary preference updates.
 *
 * `webhookConfig` is intentionally absent: signing secrets are write-only via
 * the dedicated webhook configuration endpoint. Entity identifiers and the
 * unsubscribe token are also excluded to prevent mass assignment.
 */
export class PatchPreferencesDto {
  @ApiPropertyOptional({ type: ChannelPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ChannelPreferencesDto)
  channels?: ChannelPreferencesDto;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  categorySubscriptions?: Record<string, boolean>;

  @ApiPropertyOptional({ type: QuietHoursDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto;

  @ApiPropertyOptional({ type: DigestPreferencesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DigestPreferencesDto)
  digestPreferences?: DigestPreferencesDto;

  @ApiPropertyOptional({ type: PushConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PushConfigDto)
  pushConfig?: PushConfigDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxNotificationsPerDay?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxEmailsPerDay?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  emailAddress?: string;
}
