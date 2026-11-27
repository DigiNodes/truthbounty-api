import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class DigestPreferencesDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsIn(['DAILY', 'WEEKLY'], {
    message: 'frequency must be DAILY or WEEKLY',
  })
  frequency?: 'DAILY' | 'WEEKLY';

  @IsOptional()
  @IsString()
  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/, {
    message: 'deliveryTime must use the HH:mm format',
  })
  deliveryTime?: string;
}
