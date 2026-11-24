import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  QuarantineFailureKind,
  QuarantineReason,
  QuarantineStatus,
} from './entities/event-quarantine.entity';
import { QuarantineRecordView } from './event-quarantine.service';

/** Privacy-safe quarantine record (no raw payload, no free-form detail). */
export class QuarantineRecordDto implements QuarantineRecordView {
  @ApiProperty()
  id: string;

  @ApiProperty()
  chainId: number;

  @ApiProperty()
  contractAddress: string;

  @ApiProperty()
  txHash: string;

  @ApiProperty()
  logIndex: number;

  @ApiProperty()
  blockNumber: string;

  @ApiProperty({ nullable: true })
  topic0: string | null;

  @ApiProperty({ enum: QuarantineReason })
  reason: QuarantineReason;

  @ApiProperty({ enum: QuarantineFailureKind, nullable: true })
  failureKind: QuarantineFailureKind | null;

  @ApiProperty({ enum: QuarantineStatus })
  status: QuarantineStatus;

  @ApiProperty({ nullable: true })
  artifactVersion: string | null;

  @ApiProperty({ nullable: true })
  abiChecksum: string | null;

  @ApiProperty({ nullable: true })
  eventSignature: string | null;

  @ApiProperty({ nullable: true })
  dataHash: string | null;

  @ApiProperty({ nullable: true })
  dataLength: number | null;

  @ApiProperty({ nullable: true })
  topicCount: number | null;

  @ApiProperty()
  replayAttempts: number;

  @ApiProperty({ nullable: true })
  replayedAt: Date | null;

  @ApiProperty({ nullable: true })
  replayedBy: string | null;

  @ApiProperty({ nullable: true })
  lastReplayErrorCode: string | null;

  @ApiProperty()
  quarantinedAt: Date;

  @ApiProperty({ nullable: true })
  retentionUntil: Date | null;
}

/** Paginated quarantine list. */
export class QuarantineListDto {
  @ApiProperty({ type: [QuarantineRecordDto] })
  items: QuarantineRecordDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  offset: number;
}

/** Filters for the quarantine list. */
export class QuarantineListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @ApiPropertyOptional({ enum: QuarantineReason })
  @IsOptional()
  @IsEnum(QuarantineReason)
  reason?: QuarantineReason;

  @ApiPropertyOptional({
    enum: QuarantineStatus,
    default: QuarantineStatus.OPEN,
  })
  @IsOptional()
  @IsEnum(QuarantineStatus)
  status?: QuarantineStatus;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Body for a reviewed quarantine replay. */
export class ReplayQuarantineRequestDto {
  @ApiProperty({
    description: 'Why the operator is replaying this log (audited).',
    example: 'approved artifact v2.1.0 fixes the missing event',
  })
  @IsString()
  @Length(1, 256)
  reason: string;

  @ApiPropertyOptional({
    description:
      'Artifact version the operator reviewed; replay fails closed if it does not match.',
    example: '2.1.0',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  expectedArtifactVersion?: string;
}

/** Result of a reviewed replay. */
export class ReplayQuarantineResponseDto {
  @ApiProperty({ enum: ['replayed', 'already_replayed'] })
  status: 'replayed' | 'already_replayed';

  @ApiProperty({ enum: ['ingested', 'duplicate', 'already_replayed'] })
  canonicalStatus: 'ingested' | 'duplicate' | 'already_replayed';

  @ApiProperty()
  quarantineId: string;

  @ApiProperty()
  artifactVersion: string;
}
