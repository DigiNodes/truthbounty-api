import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * V2-BE-103: Enforce Wallet-to-User Identity Integrity
 *
 * One row per (walletAddress, chainId), and every row points at exactly one
 * user. The unique index is the enforcement point rather than a convenience:
 * a read-then-write check alone cannot stop two concurrent link requests from
 * each seeing "no existing row" and both inserting. The database rejects the
 * second one, and the service turns that into a conflict.
 */
@Entity('wallet_identities')
@Index(['walletAddress', 'chainId'], { unique: true })
@Index(['userId'])
export class WalletIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Wallet address this identity is bound to, always lowercase. */
  @Column({ type: 'varchar', length: 42 })
  walletAddress: string;

  /** Chain ID the address is bound on, so the same address can exist across chains. */
  @Column({ type: 'integer' })
  chainId: number;

  /** The single user identity that owns this wallet. Immutable once bound. */
  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
