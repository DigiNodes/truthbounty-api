import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  IsTimeZone,
} from 'class-validator';

export class QuietHoursDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/, {
    message: 'startTime must use the HH:mm format',
  })
  startTime?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/, {
    message: 'endTime must use the HH:mm format',
  })
  endTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @IsTimeZone()
  timezone?: string;
}

