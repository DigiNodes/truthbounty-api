import { ApiProperty } from '@nestjs/swagger';
import { ReorgRecoveryStatus } from '../../v2/events/interfaces/reorg-recovery.interface';

export const PUBLIC_REORG_SCHEMA_VERSION = '1.0.0';

/**
 * Allow-listed, fail-closed public view of reorg recovery status.
 * Never exposes secrets, journal rows, or protected rationale.
 *
 * Freshness labelling:
 *   - status `HEALTHY` → nothing is in progress.
 *   - `ROLLING_BACK` / `REPLAYING` → recovery in progress.
 *   - `RECOVERED` → last reorg was handled.
 *   - `STOPPED_DEEP_REORG` / `STOPPED_AMBIGUOUS` → fail-closed, requires ops.
 */
export class PublicReorgStatusResponseDto {
  @ApiProperty({ enum: ReorgRecoveryStatus })
  status: ReorgRecoveryStatus;

  @ApiProperty({ example: 10 })
  chainId: number;

  @ApiProperty({ nullable: true, type: String })
  detectedAt: string | null;

  @ApiProperty({ nullable: true, type: String })
  recoveredAt: string | null;

  @ApiProperty({ nullable: true, type: String })
  forkBlockNumber: string | null;

  @ApiProperty({ nullable: true, type: Number })
  reorgDepth: number | null;

  @ApiProperty({ nullable: true, type: String })
  reason: string | null;
}
