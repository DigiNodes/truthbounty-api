import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('indexer_checkpoint')
export class IndexerCheckpoint {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'last_block', type: 'bigint' })
  lastBlock: number;

  @Column({ name: 'updated_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}