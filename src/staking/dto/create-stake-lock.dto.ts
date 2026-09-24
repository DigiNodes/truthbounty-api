import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateStakeLockDto {
  @IsString()
  @IsNotEmpty()
  walletAddress: string;

  @IsString()
  @IsNotEmpty()
  claimId: string;

  @IsString()
  @IsNotEmpty()
  amount: string;

  /** UNIX seconds at which the lock releases */
  @IsNotEmpty()
  unlocksAt: number;

  @IsOptional()
  @IsString()
  reason?: string | null;
}
