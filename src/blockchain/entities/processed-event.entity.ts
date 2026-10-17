import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * Canonical log identity for an indexed contract event.
 *
 * The unique key is (txHash, logIndex) for a given chain + release + decoder version. This is the storage-level
 * enforcement of idempotency: reprocessing the same log (duplicate batch, overlapping poll, restart)
 * cannot create a second row, and thus cannot duplicate effects.
 */
@Entity('processed_events')
@Index('processed_events_canonical_identity_key', ['chainId', 'releaseId', 'txHash', 'logIndex', 'decoderVersion'], {
  unique: true,
})
@Index('processed_events_block_hash_idx', ['blockHash'])
@Index('processed_events_removed_idx', ['removed'])
export class ProcessedEvent {
  @PrimaryGeneratedColumn()
  id: number;

  /** Chain the event was ingested from. Part of the canonical identity. */
  @Column({name: 'chain_id', type: 'int', default: 1})
  chainId: number;

  /** Release/artifact provenance the event was decoded against. */
  @Column({name: 'release_id', length: 128, default: ''})
  releaseId: string;

  /** Decoder version used to decode this log. Traceable for audit and replay. */
  @Column({name: 'decoder_version', length: 64, default: ''})
  decoderVersion: string;

  @Column({name: 'tx_hash', length: 66})
  txHash: string;

  @Column({name: 'log_index', type: 'int'})
  logIndex: number;

  @Column({name: 'block_number', type: 'bigint'})
  blockNumber: number;

  /** Hash of the block this log was included in. */
  @Column({name: 'block_hash', length: 66, default: ''})
  blockHash: string;

  @Column({name: 'event_type', length: 100})
  eventType: string;

  /**
   * Decoded event payload, retained so a reorg rollback can reverse the exact
   * state mutation this event applied (e.g. the Transfer amounts). Nullable for
   * backwards compatibility with rows written before this column existed.
   */
  @Column({name: 'payload', type: 'simple-json', nullable: true})
  payload: Record<string, any> | null;

  /**
   * Set when the chain reports this log as removed (e.g. a reorg or a filter delivering
   * a removed log). Removed logs are kept for audit until the rollback flow consumes
   * them, but they are never treated as applied state.
   */
  @Column({name: 'removed', type: 'boolean', default: false})
  removed: boolean;

  @Column({
    name: 'processed_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  processedAt: Date;
}
