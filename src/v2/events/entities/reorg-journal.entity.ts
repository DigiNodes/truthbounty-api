import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum JournalMutationType {
  INSERT = 'INSERT',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
}

/**
 * ReorgJournalEntry — V2-BE-003 (#598)
 * 
 * Records every projection mutation so we can precisely reverse it during a reorg.
 * Bound to chainId, blockHash, and parentHash to detect forks.
 */
@Entity('v2_reorg_journal')
@Index(['chainId', 'blockNumber', 'logIndex'])
@Index(['blockHash'])
export class ReorgJournalEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 66 })
  blockHash: string;

  @Column({ type: 'varchar', length: 66 })
  parentHash: string;

  @Column({ type: 'numeric', precision: 78, scale: 0 })
  blockNumber: string;

  @Column({ type: 'int' })
  logIndex: number;

  @Column({ type: 'varchar', length: 66, nullable: true })
  txHash: string | null;

  /** Which projector/read model this mutation belongs to (e.g., 'v2-evidence') */
  @Column({ type: 'varchar', length: 100 })
  projectionName: string;

  @Column({ type: 'enum', enum: JournalMutationType })
  mutationType: JournalMutationType;

  /** 
   * The exact row state BEFORE the mutation. To rollback, we overwrite the 
   * current row with this JSON, or if type is INSERT, we delete the row.
   */
  @Column({ type: 'jsonb', nullable: true })
  previousState: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;
}
