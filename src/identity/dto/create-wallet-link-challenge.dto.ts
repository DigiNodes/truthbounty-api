import { IsNotEmpty, IsString } from 'class-validator';

export class CreateWalletLinkChallengeDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  chain: string;
}
