import { IsArray, IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { NotificationChannel } from '../enums/notification-channel.enum';
import { NotificationCategory } from '../enums/notification-category.enum';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePreferenceDto {
  @ApiPropertyOptional({ type: [String], enum: NotificationChannel })
  @IsArray()
  @IsEnum(NotificationChannel, { each: true })
  @IsOptional()
  enabledChannels?: string[];

  @ApiPropertyOptional({ type: [String], enum: NotificationCategory })
  @IsArray()
  @IsEnum(NotificationCategory, { each: true })
  @IsOptional()
  disabledCategories?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  digestMode?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  quietHoursEnabled?: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  quietHoursStart?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  quietHoursEnd?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  language?: string;
}
