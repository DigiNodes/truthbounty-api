import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VerifyWorldcoinDto {
  @ApiProperty({
    description: 'User ID to associate with the verification',
    example: 'user-123-abc',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'Worldcoin proof object',
    example: {
      merkle_root: '0x123...',
      nullifier_hash: '0x456...',
      proof: '0x789...',
      verification_level: 'orb',
    },
  })
  @IsObject()
  @IsNotEmpty()
  proof: {
    merkle_root: string;
    nullifier_hash: string;
    proof: string;
    verification_level: string;
  };

  @ApiProperty({
    description: 'Action ID for the verification',
    example: 'truthbounty-verify',
  })
  @IsString()
  @IsNotEmpty()
  action: string;

  @ApiPropertyOptional({
    description: 'Optional signal data',
    example: 'optional-user-data',
  })
  @IsString()
  @IsOptional()
  signal?: string;
}
