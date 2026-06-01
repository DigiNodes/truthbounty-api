import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('processed_events')
@Index(['txHash', 'logIndex'], { unique: true })
export class ProcessedEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'tx_hash', length: 66 })
  txHash: string;

  @Column({ name: 'log_index', type: 'int' })
  logIndex: number;

  @Column({ name: 'block_number', type: 'bigint' })
  blockNumber: number;

  @Column({ name: 'event_type', length: 100 })
  eventType: string;

  /**
   * Decoded event payload, retained so a reorg rollback can reverse the exact
   * state mutation this event applied (e.g. the Transfer amounts). Nullable for
   * backwards compatibility with rows written before this column existed.
   */
  @Column({ name: 'payload', type: 'simple-json', nullable: true })
  payload: Record<string, any> | null;

  @Column({ name: 'processed_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  processedAt: Date;
}