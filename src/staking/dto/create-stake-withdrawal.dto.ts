import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateStakeWithdrawalDto {
  @IsString()
  @IsNotEmpty()
  walletAddress: string;

  @IsString()
  @IsNotEmpty()
  claimId: string;

  @IsString()
  @IsNotEmpty()
  amount: string;

  @IsString()
  @IsNotEmpty()
  txHash: string;

  @IsOptional()
  blockNumber?: number;
}
