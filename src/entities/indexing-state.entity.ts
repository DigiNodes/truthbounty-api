import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Tracks indexing state per contract/event type combination
 * Enables restart-safe, resumable indexing and prevents re-processing
 */
@Entity('indexing_state')
@Index(['chainId', 'contractAddress', 'eventType'], { unique: true })
export class IndexingState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Chain ID (e.g., 10 for Optimism)
   */
  @Column({ type: 'integer' })
  chainId: number;

  /**
   * Smart contract address being indexed
   */
  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  /**
   * Event type being indexed (e.g., 'StakeMinted', 'RewardClaimed')
   */
  @Column({ type: 'varchar', length: 255 })
  eventType: string;

  /**
   * Last block number that was successfully processed
   */
  @Column({ type: 'bigint' })
  lastProcessedBlockNumber: number;

  /**
   * Block number up to which we've scanned (may be unprocessed)
   */
  @Column({ type: 'bigint', default: 0 })
  lastScannedBlockNumber: number;

  /**
   * The last finalized block number (reorg-safe)
   * Events in this range are considered immutable
   */
  @Column({ type: 'bigint', nullable: true })
  lastFinalizedBlockNumber: number | null;

  /**
   * Current processing status
   */
  @Column({
    type: 'varchar',
    length: 50,
    default: 'idle',
    enum: ['idle', 'indexing', 'backfilling', 'error'],
  })
  status: 'idle' | 'indexing' | 'backfilling' | 'error';

  /**
   * Error message if status is 'error'
   */
  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /**
   * Total events found for this contract/event type
   */
  @Column({ type: 'bigint', default: 0 })
  totalEventCount: number;

  /**
   * Number of events processed successfully
   */
  @Column({ type: 'bigint', default: 0 })
  processedEventCount: number;

  /**
   * Number of failed events awaiting retry
   */
  @Column({ type: 'integer', default: 0 })
  failedEventCount: number;

  /**
   * Configuration: block range per batch fetch (for optimization)
   */
  @Column({ type: 'integer', default: 5000 })
  blockRangePerBatch: number;

  /**
   * Configuration: block confirmations required for finalization
   */
  @Column({ type: 'integer', default: 12 })
  confirmationsRequired: number;

  /**
   * Configuration: number of retry attempts before giving up
   */
  @Column({ type: 'integer', default: 3 })
  maxRetryAttempts: number;

  /**
   * When was the last indexing attempt
   */
  @Column({ type: 'timestamp', nullable: true })
  lastIndexedAt: Date | null;

  /**
   * When was the last successful sync
   */
  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt: Date | null;

  /**
   * Creation timestamp
   */
  @CreateDateColumn()
  createdAt: Date;

  /**
   * Last update timestamp
   */
  @UpdateDateColumn()
  updatedAt: Date;
}
