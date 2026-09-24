import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ClaimState } from '../../domain/claim/claimState';

/**
 * Projected claim lifecycle read model.
 *
 * This is the eventual-consistency projection of the on-chain claim state
 * machine. It materialises a single row per claim reflecting its current
 * on-chain status, so API consumers and analytics never read raw logs.
 *
 * `eventIndex` + `eventTxHash` record which source event produced this row,
 * enabling safe re-projection and drift detection.
 */
@Entity('claim_read_models')
@Index(['claimId', 'chainId'], { unique: true })
@Index(['state'])
@Index(['settledAt'])
export class ClaimReadModel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** On-chain claim id */
  @Column({ type: 'varchar', length: 128 })
  claimId: string;

  /** Originating chain */
  @Column({ type: 'varchar', length: 32 })
  chainId: string;

  /** Current, projected on-chain state */
  @Column({ type: 'varchar', length: 64 })
  state: ClaimState;

  /** Block height of the most recent state transition */
  @Column({ type: 'bigint' })
  blockNumber: string;

  /** Transaction hash of the most recent state transition */
  @Column({ type: 'varchar', length: 128 })
  eventTxHash: string;

  /** Sequential index of the most recent source event applied */
  @Column({ type: 'int' })
  eventIndex: number;

  /** Timestamp of the most recent state transition */
  @Column({ type: 'timestamp' })
  stateChangedAt: Date;

  /** When the claim reached a terminal (Settled) state, if ever */
  @Column({ type: 'timestamp', nullable: true })
  settledAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
