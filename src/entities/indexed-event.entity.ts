import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Represents a single smart contract event that has been indexed
 * Ensures idempotency through unique constraint on (txHash, logIndex, eventType)
 */
@Entity('indexed_events')
@Index(['blockNumber', 'logIndex'], { unique: true })
@Index(['transactionHash', 'logIndex', 'eventType'], { unique: true })
@Index(['eventType', 'blockNumber'])
@Index(['processedAt'])
export class IndexedEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Event type (e.g., 'StakeMinted', 'RewardClaimed', 'ProtocolAction')
   */
  @Column({ type: 'varchar', length: 255 })
  eventType: string;

  /**
   * Smart contract address that emitted the event
   */
  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  /**
   * Transaction hash where event was emitted
   */
  @Column({ type: 'varchar', length: 66 })
  transactionHash: string;

  /**
   * Block number where event was mined
   */
  @Column({ type: 'bigint' })
  blockNumber: number;

  /**
   * Log index within the transaction
   */
  @Column({ type: 'integer' })
  logIndex: number;

  /**
   * Chain ID (e.g., 10 for Optimism)
   */
  @Column({ type: 'integer' })
  chainId: number;

  /**
   * Raw event data (JSON serialized)
   */
  @Column({ type: 'jsonb' })
  eventData: Record<string, any>;

  /**
   * Parsed and normalized event payload
   */
  @Column({ type: 'jsonb' })
  parsedData: Record<string, any>;

  /**
   * Number of confirmations when processed
   * Set to indicate reorg safety threshold met
   */
  @Column({ type: 'integer', default: 0 })
  confirmations: number;

  /**
   * Whether event has been marked as finalized (passed reorg threshold)
   */
  @Column({ type: 'boolean', default: false })
  isFinalized: boolean;

  /**
   * Whether this event has been processed and synced downstream
   */
  @Column({ type: 'boolean', default: false })
  isProcessed: boolean;

  /**
   * Timestamp when event was processed
   */
  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;

  /**
   * Error message if processing failed
   */
  @Column({ type: 'text', nullable: true })
  processingError: string | null;

  /**
   * Attempt count for failed events
   */
  @Column({ type: 'integer', default: 0 })
  retryAttempts: number;

  /**
   * Timestamp of when this record was created
   */
  @CreateDateColumn()
  createdAt: Date;

  /**
   * Timestamp of when this record was last updated
   */
  @UpdateDateColumn()
  updatedAt: Date;
}
