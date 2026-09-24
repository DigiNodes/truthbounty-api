import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

/**
 * Per-(chain, contract) ingestion cursor.
 *
 * V2-BE-011 depends on V2-BE-010 ("Implement Reorg-Safe Event Cursor and
 * Checkpoint Store"), which has not merged and has no frozen interface yet.
 * This entity is a deliberately minimal stand-in: it tracks a safe block
 * (finality-lagged, safe to read) and a finalized block, and is advanced in
 * the same DB transaction as the canonical-event writes it accompanies so a
 * crash mid-batch can never leave the cursor ahead of the data it describes.
 * It is expected to be replaced or reconciled once V2-BE-010 lands; see the
 * PR description for the residual rework this implies.
 */
@Entity('v2_event_checkpoints')
@Unique('uq_v2_checkpoint_source', ['chainId', 'contractAddress'])
export class EventCheckpoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  @Column({ type: 'bigint', default: 0 })
  lastSafeBlock: string;

  @Column({ type: 'bigint', default: 0 })
  lastFinalizedBlock: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
