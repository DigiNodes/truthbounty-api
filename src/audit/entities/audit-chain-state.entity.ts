import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Singleton row (id = AUDIT_CHAIN_STATE_ID) tracking the tip of the
 * audit-log hash chain.
 *
 * Every write to `audit_logs` must, within the same transaction:
 *   1. Take a row lock on this table (SELECT ... FOR UPDATE).
 *   2. Read `lastHash` / `lastSequence` to compute the new record's
 *      `previousHash` / `chainSequence`.
 *   3. Update this row to the newly written record's hash/sequence.
 *
 * This serializes audit writes (by design) so the chain can never fork
 * under concurrent writers, and makes a deleted or re-ordered record
 * detectable: `verifyChain()` walks records in `chainSequence` order and
 * confirms each record's `previousHash` matches the prior record's
 * `integrityHash`, with no gaps in the sequence.
 */
@Entity('audit_chain_state')
export class AuditChainState {
  @PrimaryColumn({ type: 'smallint' })
  id: number;

  @Column({ type: 'varchar', nullable: true })
  lastHash: string | null;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | number) => Number(value),
    },
  })
  lastSequence: number;

  @UpdateDateColumn()
  updatedAt: Date;
}

/** There is exactly one chain per deployment; this is its fixed id. */
export const AUDIT_CHAIN_STATE_ID = 1;
