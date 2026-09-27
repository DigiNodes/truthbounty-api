import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Tracks issued SIWE nonces to enforce single-use consumption
 * and prevent replay attacks.
 *
 * A nonce must be:
 * 1. Issued by this backend for the requesting address.
 * 2. Consumed exactly once within its TTL window.
 * 3. Bound to the issuing domain and chainId.
 */
@Entity('siwe_nonces')
@Index(['nonce'], { unique: true })
@Index(['address', 'isConsumed'])
export class SiweNonce {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Cryptographically random nonce value (hex, 32 bytes). */
  @Column({ type: 'varchar', length: 64 })
  nonce: string;

  /** EVM address this nonce was issued for (lowercase). */
  @Column({ type: 'varchar', length: 42 })
  address: string;

  /** Domain that must appear verbatim in the SIWE message. */
  @Column({ type: 'varchar', length: 253 })
  domain: string;

  /** Chain ID this nonce is valid for. */
  @Column({ type: 'integer' })
  chainId: number;

  /** Whether the nonce has already been consumed by a successful auth. */
  @Column({ type: 'boolean', default: false })
  isConsumed: boolean;

  /** UTC expiry timestamp; reject if now > expiresAt. */
  @Column({ type: 'datetime' })
  expiresAt: Date;

  @CreateDateColumn()
  issuedAt: Date;
}
