import { IsEthereumAddress, IsNotEmpty, IsString } from 'class-validator';

export class LinkWalletDto {
  @IsEthereumAddress({ message: 'address must be a valid Ethereum address' })
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  chain: string;

  @IsString()
  @IsNotEmpty()
  signature: string;

  @IsString()
  @IsNotEmpty()
  message: string;
}
