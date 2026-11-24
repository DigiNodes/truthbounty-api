import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

/** Coarse reason a log was quarantined (stable, backward-compatible). */
export enum QuarantineReason {
  UNREGISTERED_ADDRESS = 'unregistered_address',
  UNKNOWN_SIGNATURE = 'unknown_signature',
  ARTIFACT_DRIFT = 'artifact_drift',
  DECODE_ERROR = 'decode_error',
  ABI_MISMATCH = 'abi_mismatch',
}

/** Precise failure classification for operators and readiness reporting. */
export enum QuarantineFailureKind {
  UNREGISTERED_ADDRESS = 'unregistered_address',
  UNKNOWN_TOPIC = 'unknown_topic',
  ABI_MISMATCH = 'abi_mismatch',
  ARTIFACT_DRIFT = 'artifact_drift',
  MALFORMED_LOG = 'malformed_log',
  DECODER_FAILURE = 'decoder_failure',
}

/** Lifecycle of a quarantined log. Only `open` rows block readiness. */
export enum QuarantineStatus {
  OPEN = 'open',
  REPLAYED = 'replayed',
}

const QUARANTINE_REASONS =
  "'unregistered_address','unknown_signature','artifact_drift','decode_error','abi_mismatch'";
const QUARANTINE_STATUSES = "'open','replayed'";

/**
 * Raw logs that could not be decoded/normalized safely are quarantined here
 * instead of being dropped or force-decoded, so artifact drift, unknown topics,
 * malformed logs and rogue addresses stay visible, bounded and auditable.
 *
 * Rows are immutable identity-wise (`chainId,txHash,logIndex` unique) and carry
 * only bounded metadata. The full `rawLog` is retained only while the row is
 * `open` (replay needs it) and is scrubbed on successful replay; `dataHash` and
 * `dataLength` survive so the event stays auditable without keeping payloads.
 */
@Entity('v2_event_quarantine')
@Unique('uq_v2_quarantine_identity', ['chainId', 'txHash', 'logIndex'])
@Index(['reason'])
@Index(['status', 'reason'])
@Index(['status', 'quarantinedAt'])
@Check('chk_v2_quarantine_chain_positive', '"chainId" > 0')
@Check('chk_v2_quarantine_log_nonneg', '"logIndex" >= 0')
@Check('chk_v2_quarantine_block_nonneg', '"blockNumber" >= 0')
@Check('chk_v2_quarantine_reason', `"reason" IN (${QUARANTINE_REASONS})`)
@Check('chk_v2_quarantine_status', `"status" IN (${QUARANTINE_STATUSES})`)
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

  /** Precise classification; `null` for rows created before #647. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  failureKind: QuarantineFailureKind | null;

  @Column({ type: 'varchar', length: 16, default: QuarantineStatus.OPEN })
  status: QuarantineStatus;

  /** Bounded raw payload; `null` after a successful replay (scrubbed). */
  @Column({ type: 'json', nullable: true })
  rawLog: Record<string, unknown> | null;

  /** Bounded, human-readable classification detail (max 512 chars). */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  /** Provenance of the artifact that failed to decode this log, if known. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  artifactVersion: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  abiChecksum: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  eventSignature: string | null;

  /** sha256 over topics||data; survives rawLog scrubbing. */
  @Column({ type: 'varchar', length: 66, nullable: true })
  dataHash: string | null;

  @Column({ type: 'int', nullable: true })
  dataLength: number | null;

  @Column({ type: 'int', nullable: true })
  topicCount: number | null;

  @Column({ type: 'int', default: 0 })
  replayAttempts: number;

  @Column({ type: 'timestamp', nullable: true })
  replayedAt: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  replayedBy: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastReplayErrorCode: string | null;

  /** Set on replay; replayed rows older than this are retention-eligible. */
  @Column({ type: 'timestamp', nullable: true })
  retentionUntil: Date | null;

  @CreateDateColumn()
  quarantinedAt: Date;
}
