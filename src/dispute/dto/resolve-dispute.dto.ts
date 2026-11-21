import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Deprecated: the former resolve endpoint no longer accepts an outcome or a
 * final confidence. Those are protocol-authoritative fields and can only be
 * projected from a finalized canonical event. This DTO now records an
 * explicitly non-authoritative triage note.
 */
export class ResolveDisputeDto {
  @ApiPropertyOptional({ description: 'Non-authoritative triage note' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    description: 'Additional non-authoritative triage metadata',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
