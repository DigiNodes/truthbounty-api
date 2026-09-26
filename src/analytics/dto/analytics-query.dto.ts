import { IsOptional, IsString, IsDateString, IsNumber, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';

export class AnalyticsQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
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
  @IsIn(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'])
  period?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(String(value), 10))
  @IsNumber()
  limit?: number = 10;
}
