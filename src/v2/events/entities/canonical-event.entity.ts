import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * A single normalized, decoded smart-contract event.
 *
 * This is the boundary V2-BE-011 owns: contracts emit facts, this table is
 * the deterministic projection of those facts, and every downstream V2 read
 * model (evidence, verification, disputes, ...) is built exclusively from
 * rows in this table rather than talking to RPC/ABI concerns directly.
 *
 * Amounts are stored as decimal strings, never floating point, since the
 * contract is the source of truth for token accounting and this table must
 * not introduce precision drift.
 */
@Entity('v2_canonical_events')
@Unique('uq_v2_canonical_event_identity', ['chainId', 'txHash', 'logIndex'])
@Index(['blockNumber', 'logIndex'])
@Index(['eventName', 'blockNumber'])
@Index(['claimId'])
@Index(['roundId'])
export class CanonicalEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  /** The approved-artifact version this event was decoded against. */
  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  /** Canonical event name, unchanged from the protocol's own naming. */
  @Column({ type: 'varchar', length: 128 })
  eventName: string;

  @Column({ type: 'varchar', length: 66 })
  txHash: string;

  @Column({ type: 'int' })
  logIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  // `type: Date` (constructor, not a string) lets TypeORM pick the
  // driver-appropriate timestamp column itself -- postgres in production,
  // sqlite in the in-memory integration test -- instead of a hardcoded
  // dialect-specific string that only one of the two supports.
  @Column({ type: Date, nullable: true })
  blockTimestamp: Date | null;

  /** Normalized actor address, when the event carries one. Lowercased hex. */
  @Column({ type: 'varchar', length: 42, nullable: true })
  actor: string | null;

  /** Opaque protocol claim identifier (bytes32 hex), when applicable. */
  @Column({ type: 'varchar', length: 66, nullable: true })
  claimId: string | null;

  /** Opaque protocol round identifier, when applicable. */
  @Column({ type: 'varchar', length: 66, nullable: true })
  roundId: string | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  asset: string | null;

  /** Decimal string. Never a JS number/float. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  amount: string | null;

  /** Full normalized field set for this event name (superset of the columns above). */
  @Column({ type: 'json' })
  payload: Record<string, unknown>;

  /** Raw decoded args exactly as returned by the ABI decoder, for audit. */
  @Column({ type: 'json' })
  rawArgs: Record<string, unknown>;

  @CreateDateColumn()
  ingestedAt: Date;
}
