import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

export enum QuarantineReason {
  UNREGISTERED_ADDRESS = 'unregistered_address',
  UNKNOWN_SIGNATURE = 'unknown_signature',
  ARTIFACT_DRIFT = 'artifact_drift',
  DECODE_ERROR = 'decode_error',
}

/**
 * Raw logs that could not be decoded/normalized safely are quarantined here
 * instead of being dropped or force-decoded, so artifact drift and rogue
 * addresses stay visible and auditable rather than silently discarded.
 */
@Entity('v2_event_quarantine')
@Unique('uq_v2_quarantine_identity', ['chainId', 'txHash', 'logIndex'])
@Index(['reason'])
@Check('chk_v2_quarantine_chain_positive', '"chainId" > 0')
@Check('chk_v2_quarantine_log_nonneg', '"logIndex" >= 0')
@Check('chk_v2_quarantine_block_nonneg', '"blockNumber" >= 0')
@Check(
  'chk_v2_quarantine_reason',
  "\"reason\" IN ('unregistered_address','unknown_signature','artifact_drift','decode_error')",
)
export class EventQuarantine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  @Column({ type: 'varchar', length: 66 })
  txHash: string;

  @Column({ type: 'int' })
  logIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @Column({ type: 'varchar', length: 66, nullable: true })
  topic0: string | null;

  @Column({ type: 'varchar', length: 32 })
  reason: QuarantineReason;

  @Column({ type: 'json' })
  rawLog: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @CreateDateColumn()
  quarantinedAt: Date;
}
