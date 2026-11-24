import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('indexer_checkpoint')
@Index('idx_checkpoint_chain_release', ['chainId', 'releaseId', 'projection'], { unique: true })
export class IndexerCheckpoint {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Chain ID this cursor is bound to. Defaults to 1 for legacy rows.
   */
  @Column({ name: 'chain_id', type: 'integer', default: 1 })
  chainId: number;

  /**
   * Release IDentifier this cursor is bound to. Defaults to 'legacy'.
   */
  @Column({ name: 'release_id', type: 'varchar', length: 64, default: 'legacy' })
  releaseId: string;

  /**
   * Projection name (e.g. 'default', 'claims', 'balances'). Defaults to 'default'.
   */
  @Column({ type: 'varchar', length: 64, default: 'default' })
  projection: string;

  /**
   * Highest block height whose projection effects are committed.
   */
  @Column({ name: 'last_block', type: 'bigint', default: 0 })
  lastBlock: number;

  /**
   * Block hash at lastBlock. Used to detect same-height/different-hash
   * disagreement (fails closed).
   */
  @Column({ type: 'varchar', length: 66, default: '' })
  lastBlockHash: string;

  /**
   * Finalized head observed at the time the cursor was advanced.
   */
  @Column({ name: 'finalized_head', type: 'bigint', default: 0 })
  finalizedHead: number;

  /**
   * Deployment floor for the release. Cursor must never go below this.
   */
  @Column({ type: 'bigint', default: 0 })
  deploymentBlock: number;

  /**
   * Artifact checksum (binding provenance).
   */
  @Column({ name: 'artifact_checksum', type: 'varchar', length: 64, default: '' })
  artifactChecksum: string;

  /**
   * Deployment block hash (binding provenance).
   */
  @Column({ name: 'deployment_block_hash', type: 'varchar', length: 66, default: '' })
  deploymentBlockHash: string;

  /**
   * Checkpoint provenance (e.g. source of the checkpoint).
   */
  @Column({ name: 'checkpoint_provenance', type: 'varchar', length: 128, default: '' })
  checkpointProvenance: string;

  /**
   * Monotonic version counter for compare-and-swap. Incremented on every
   * successful advance or authorized rollback.
   */
  @Column({ type: 'integer', default: 0 })
  version: number;

  /**
   * Last authorized rollback audit metadata (JSON). Null when no rollback
   * has occurred.
   */
  @Column({ name: 'last_rollback_aud', type: 'text', nullable: true })
  lastRollbackAud: string | null;

  /**
   * Optimistic concurrency token used by the compare-and-swap advance path.
   * Writers must present the version they read; mismatches fail closed.
   */
  @Column({ name: 'cas_token', type: 'varchar', length: 64, default: '' })
  casToken: string;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;
}
