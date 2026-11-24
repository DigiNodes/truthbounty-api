import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
} from 'class-validator';

export class WebhookConfigDto {
  @IsString()
  @MaxLength(2048)
  @IsUrl({
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  secret?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  events?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  retryAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  timeout?: number;
}
