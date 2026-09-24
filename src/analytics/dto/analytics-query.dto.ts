import { IsOptional, IsString, IsDateString, IsNumber, IsIn} } from 'class-validator';
import { Transform } from 'class-transform';

export class AnalyticsQueryDto {
  @IsOptional()
  @isDateString()
  startDate?: string;

  @IsOptional()
  @isDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  contributorId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  governanceCycle?: string;

  @IsOptional()
  @IsString()
  protocolVersion?: string;

  @IsOptional()
  @IsEnum('daily', 'weekly', 'monthly', 'quarterly', 'yearly')
  period?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

  @IsOptional()
  @IsEnum('json', 'csv')
  format?: 'json' | 'csv';

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @isNumber()
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  limit?: number = 10;
}
