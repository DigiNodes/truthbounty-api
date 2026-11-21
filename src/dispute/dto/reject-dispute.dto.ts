import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Deprecated: the former reject endpoint records a non-authoritative triage
 * reason only. It cannot set a terminal `REJECTED` protocol outcome, and the
 * actor is the verified principal rather than a client-supplied `rejectedBy`.
 */
export class RejectDisputeDto {
  @ApiProperty({ description: 'Reason for the non-authoritative triage' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
