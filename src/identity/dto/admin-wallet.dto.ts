import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { LinkWalletDto } from './link-wallet.dto';

export class AdminLinkWalletDto extends LinkWalletDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  reason: string;
}

export class AdminUnlinkWalletDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  reason: string;
}
