import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Non-authoritative IPFS preparation request. This DTO never carries verdict,
 * finalized, registered, version or transaction fields: those are protocol
 * state and can only originate from a finalized canonical event.
 */
export class PrepareEvidenceUploadDto {
  @ApiProperty({
    description:
      'UTF-8 content (or base64 when encoding=base64) to pin on IPFS',
  })
  content: string;

  @ApiPropertyOptional({ enum: ['utf8', 'base64'], default: 'utf8' })
  encoding?: 'utf8' | 'base64';

  @ApiPropertyOptional({
    description: 'Optional filename hint for the provider',
  })
  filename?: string;
}
