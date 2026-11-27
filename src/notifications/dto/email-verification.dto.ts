import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RequestEmailVerificationDto {
  @ApiProperty({
    description: 'Email address to verify for notification delivery',
    example: 'user@example.com',
  })
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ConfirmEmailVerificationDto {
  @ApiProperty({
    description: 'Single-use verification token from the confirmation email',
    example: 'a3f8c...',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(256)
  token: string;
}

export class EmailVerificationStatusResponseDto {
  @ApiProperty({
    description: 'Whether the user currently has a verified notification email',
  })
  verified: boolean;

  @ApiProperty({
    description: 'Whether there is a pending (unconfirmed) verification challenge',
  })
  pendingChallenge: boolean;

  @ApiProperty({
    description: 'Expiry timestamp of the pending challenge, if one exists',
    required: false,
    nullable: true,
  })
  pendingChallengeExpiresAt?: Date | null;
}
