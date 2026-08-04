import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateContextDocumentDto } from './create-context-document.dto';

export class UpdateContextDocumentDto extends PartialType(
  CreateContextDocumentDto,
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
