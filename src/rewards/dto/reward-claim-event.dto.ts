/* eslint-disable @typescript-eslint/no-unsafe-call */
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsEthereumAddress,
} from 'class-validator';

export class RewardClaimEventDto {
  @IsEthereumAddress()
  @IsNotEmpty()
  walletAddress: string;

  @IsString()
  @IsNotEmpty()
  amount: string;

  @IsString()
  @IsOptional()
  claimId?: string;

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
