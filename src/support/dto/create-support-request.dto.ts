import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

export const SUPPORT_CATEGORIES = [
  'bug',
  'question',
  'account',
  'technical',
  'content',
  'other',
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export class CreateSupportRequestDto {
  @ApiProperty({
    enum: SUPPORT_CATEGORIES,
    description: 'Primary support category',
    example: 'bug',
  })
  @IsEnum(SUPPORT_CATEGORIES as unknown as any)
  category!: SupportCategory;

  @ApiProperty({
    description: 'Minimal contact method; email, wallet handle, or user ID only',
    example: 'support@example.com',
  })
  @IsString()
  @Length(3, 200)
  @Matches(/^(?:[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_.-]{3,64}|0x[a-fA-F0-9]{6,40})$/)
  contact!: string;

  @ApiProperty({
    description: 'Support request description without private material or protected evidence',
    example: 'The app crashes when submitting a claim with evidence attached.',
  })
  @IsString()
  @Length(10, 5000)
  description!: string;

  @ApiPropertyOptional({
    description: 'Release or build identifier for the affected deployment',
    example: 'v1.2.3',
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  release?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Safe diagnostic references only (requestId, traceId, release, claimId)',
    example: ['requestId: abc123', 'release: v1.2.3'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  diagnostics?: string[];

  @ApiPropertyOptional({
    description: 'Optional client-generated idempotency key for duplicate suppression',
    example: 'support-abc123',
  })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
