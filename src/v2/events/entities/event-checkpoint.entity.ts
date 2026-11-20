import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  Unique,
  Check,
} from 'typeorm';

/**
 * Per-(chain, contract) ingestion cursor.
 *
 * Three facts are persisted separately and must never be conflated:
 *  - `lastProcessedBlock`: ingestion progress (the highest canonical log
 *    processed for this contract), independent of chain finality.
 *  - `lastSafeBlock` / hash: the provider-observed safe head.
 *  - `lastFinalizedBlock` / hash: the provider-observed finalized head.
 *
 * The finality fields are derived only from provider-reported chain heads.
 * They are advanced in the same DB transaction as the event writes they
 * accompany, so a crash mid-batch can never leave the cursor ahead of the
 * data it describes. `headSource` and `headsObservedAt` record the provenance
 * and observation time so read models can fail closed when finality is stale
 * or unavailable.
 */
@Entity('v2_event_checkpoints')
@Unique('uq_v2_checkpoint_source', ['chainId', 'contractAddress'])
@Check('chk_v2_checkpoint_chain_positive', '"chainId" > 0')
@Check('chk_v2_checkpoint_processed_nonneg', '"lastProcessedBlock" >= 0')
@Check('chk_v2_checkpoint_safe_nonneg', '"lastSafeBlock" >= 0')
@Check('chk_v2_checkpoint_final_nonneg', '"lastFinalizedBlock" >= 0')
@Check(
  'chk_v2_checkpoint_final_lte_safe',
  '"lastFinalizedBlock" <= "lastSafeBlock"',
)
export class EventCheckpoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  /** Highest canonical-event block processed for this contract. */
  @Column({ type: 'bigint', default: 0 })
  lastProcessedBlock: string;

  /** Provider-observed safe head (never the block of an ingested log). */
  @Column({ type: 'bigint', default: 0 })
  lastSafeBlock: string;

  @Column({ type: 'varchar', length: 66, nullable: true })
  lastSafeBlockHash: string | null;

  @Column({ type: 'bigint', default: 0 })
  lastFinalizedBlock: string;

  @Column({ type: 'varchar', length: 66, nullable: true })
  lastFinalizedBlockHash: string | null;

  /** Highest provider-observed (latest) head at the time of the advance. */
  @Column({ type: 'bigint', nullable: true })
  observedHead: string | null;

  /** Machine-readable finality source, e.g. provider finality tags. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  headSource: string | null;

  /** When the source reported the safe/finalized heads. */
  @Column({ type: 'timestamp', nullable: true })
  headsObservedAt: Date | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
