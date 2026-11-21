import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Matches, Min } from 'class-validator';

/**
 * Pointer to a single canonical log. This is evidence, never authority: the
 * referenced event is resolved and validated server-side before any terminal
 * dispute field is written. The caller cannot choose the deployment, the
 * outcome, the confidence, or the actor.
 */
export class CanonicalEventEvidenceDto {
  @ApiProperty({
    description: 'Chain ID of the canonical deployment (10 or 11155420)',
    example: 10,
  })
  @IsInt()
  chainId: number;

  @ApiProperty({
    description: 'Transaction hash of the canonical dispute event',
    example: '0x' + 'a'.repeat(64),
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[a-fA-F0-9]{64}$/)
  txHash: string;

  @ApiProperty({ description: 'Log index of the event within the transaction' })
  @IsInt()
  @Min(0)
  logIndex: number;
}
