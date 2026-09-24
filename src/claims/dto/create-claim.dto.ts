import { IsString, IsNotEmpty, IsOptional, IsUrl, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateClaimDto {
  @ApiProperty({
    description: 'Title of the claim',
    example: 'Climate change is accelerating faster than predicted',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    description: 'Detailed content/description of the claim',
    example: 'Recent scientific studies indicate that global temperature rise is exceeding previous climate models...',
    maxLength: 5000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content: string;

  @ApiPropertyOptional({
    description: 'Source URL or reference for the claim',
    example: 'https://example.com/scientific-study',
  })
  @IsOptional()
  @IsUrl()
  source?: string;

  @ApiPropertyOptional({
    description: 'Additional metadata or tags for the claim',
    example: { category: 'climate', tags: ['science', 'environment'] },
  })
  @IsOptional()
  metadata?: Record<string, any>;
}
