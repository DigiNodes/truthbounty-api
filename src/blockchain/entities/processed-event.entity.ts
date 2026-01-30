import { Entity, Column, PrimaryGeneratedColumn, Index, Unique } from 'typeorm';

@Entity('processed_events')
@Unique(['txHash', 'logIndex', 'blockNumber'])
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

  @Column({ name: 'processed_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  processedAt: Date;
}