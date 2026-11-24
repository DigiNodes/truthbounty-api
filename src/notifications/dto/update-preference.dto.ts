import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { DeliveryChannel } from '../interfaces/notification.types';
import { NotificationCategory } from '../enums/notification-category.enum';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePreferenceDto {
  @ApiPropertyOptional({ type: [String], enum: DeliveryChannel })
  @IsArray()
  @IsEnum(DeliveryChannel, { each: true })
  @IsOptional()
  enabledChannels?: DeliveryChannel[];

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
