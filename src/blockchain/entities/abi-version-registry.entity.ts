import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * Stores versioned ABI snapshots per contract address and deployment block.
 * Allows the indexer to decode events from any historical deployment
 * using the exact ABI that was canonical at that block range.
 */
@Entity('abi_version_registry')
@Unique(['contractAddress', 'chainId', 'deployedAtBlock'])
@Index(['contractAddress', 'chainId'])
export class AbiVersionRegistry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Checksummed contract address (0x-prefixed, 42 chars). */
  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  /** EVM chain ID (e.g. 10 for Optimism Mainnet). */
  @Column({ type: 'integer' })
  chainId: number;

  /**
   * Block at which this contract version was deployed.
   * Used to select the correct ABI for a given log's blockNumber.
   */
  @Column({ type: 'bigint' })
  deployedAtBlock: number;

  /** Human-readable version label, e.g. "v1.0.0" or "v2.3.1". */
  @Column({ type: 'varchar', length: 32 })
  version: string;

  /** Full ABI JSON array serialised as text. */
  @Column({ type: 'text' })
  abiJson: string;

  /** SHA-256 hex digest of abiJson for drift detection. */
  @Column({ type: 'varchar', length: 64 })
  abiHash: string;

  @CreateDateColumn()
  registeredAt: Date;
}