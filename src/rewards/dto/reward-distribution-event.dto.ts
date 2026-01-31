/* eslint-disable @typescript-eslint/no-unsafe-call */
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsArray,
  IsOptional,
} from 'class-validator';

export class RewardDistributionEventDto {
  @IsArray()
  @IsNotEmpty()
  recipients: string[];

  @IsArray()
  @IsNotEmpty()
  amounts: string[];

  @IsString()
  @IsOptional()
  distributionId?: string;

  @IsString()
  @IsNotEmpty()
  txHash: string;

  @IsNumber()
  @IsNotEmpty()
  blockNumber: number;

  @IsNumber()
  @IsNotEmpty()
  logIndex: number;

  @IsNumber()
  @IsNotEmpty()
  blockTimestamp: number;

  @IsString()
  @IsOptional()
  eventName?: string;

  @IsOptional()
  metadata?: Record<string, any>;
}
