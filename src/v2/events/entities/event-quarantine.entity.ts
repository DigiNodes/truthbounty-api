import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
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
