import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

export enum RoleChangeKind {
  GRANTED = 'GRANTED',
  REVOKED = 'REVOKED',
}

/**
 * Immutable audit trail of `RoleGranted` / `RoleRevoked` events observed
 * on the Governor (and any contract declared with the `roles` capability
 * in the manifest).
 *
 * The row is append-only; reorg reconciliation deletes rows whose
 * (txHash, logIndex) were purged from CanonicalEvent.
 */
@Entity('v2_governance_role_changes')
@Unique('uq_v2_gov_role_log', ['chainId', 'txHash', 'logIndex'])
@Index(['chainId', 'role'])
@Index(['chainId', 'account'])
@Index(['chainId', 'kind'])
export class RoleChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  /** Contract that emitted the role change. */
  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  @Column({ type: 'varchar' })
  kind: RoleChangeKind;

  /** bytes32 role identifier, 0x-prefixed hex. */
  @Column({ type: 'varchar', length: 66 })
  role: string;

  /** Checksummed account that gained or lost the role. */
  @Column({ type: 'varchar', length: 42 })
  account: string;

  /**
   * The `sender` argument from the event — the address that performed the
   * role change. For OZ `AccessControl` this is the authorised grantor.
   */
  @Column({ type: 'varchar', length: 42 })
  sender: string;

  @Column({ type: 'varchar', length: 66 })
  txHash: string;

  @Column({ type: 'int' })
  logIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @Column({ type: 'datetime', nullable: true })
  blockTimestamp: Date | null;

  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
