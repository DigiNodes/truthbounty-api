import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator';

export class RefreshDto {
  @ApiProperty({
    description: 'Refresh token received during login',
    example: 'abc123def456.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class LogoutDto {
  @ApiPropertyOptional({
    description: 'Optional: specific refresh token to invalidate. If omitted, all tokens for the user are revoked.',
  })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}

export class RevokeDto {
  @ApiProperty({
    description: 'Wallet address whose sessions should be revoked',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  })
  @IsString()
  @IsNotEmpty()
  address: string;
}

export class ChallengeDto {
  @ApiProperty({
    description: 'Wallet address to generate challenge for',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb',
  })
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiPropertyOptional({
    description: 'Chain ID for SIWE message (default: 1 for Ethereum mainnet)',
    example: 1,
    default: 1,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  chainId?: number;

  @ApiPropertyOptional({
    description: 'Domain requesting the signature',
    example: 'app.truthbounty.com',
  })
  @IsString()
  @IsOptional()
  domain?: string;

  @ApiPropertyOptional({
    description: 'URI of the requesting resource',
    example: 'https://app.truthbounty.com',
  })
  @IsString()
  @IsOptional()
  uri?: string;
}
