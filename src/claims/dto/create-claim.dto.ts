import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  MaxLength,
  IsArray,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateClaimDTO {
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
    example:
      'Recent scientific studies indicate that global temperature rise is exceeding previous climate models...',
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

  @ApiPropertyOptional({
    description:
      'Attachment references for the claim; scanned for secrets before persistence',
    example: ['https://example.com/evidence.pdf'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  attachments?: string[];

  @ApiPropertyOptional({
    description:
      'Support submission text scanned for secrets before persistence',
    example: 'Please review my claim submission',
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  supportText?: string;
}
