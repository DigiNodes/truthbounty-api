import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ContextDocumentCategory } from '../entities/context-document.entity';

export class CreateContextDocumentDto {
  @ApiProperty({ description: 'Document title', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ enum: ContextDocumentCategory })
  @IsEnum(ContextDocumentCategory)
  category: ContextDocumentCategory;

  @ApiProperty({ description: 'Document body used for retrieval and citation' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Free-text tags to aid retrieval',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Canonical source URL for this document',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  sourceUrl?: string;
}
