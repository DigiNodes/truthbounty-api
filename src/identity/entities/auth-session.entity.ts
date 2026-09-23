import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Represents an authenticated session issued after a successful SIWE login.
 *
 * Rotation: on refresh the old token is revoked and a new session row created.
 * Revocation: setting revokedAt makes the session fail-closed on any future use.
 */
@Entity('auth_sessions')
@Index(['sessionToken'], { unique: true })
@Index(['walletAddress', 'revokedAt'])
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Opaque session token (64-byte hex). Never re-issued after revocation. */
  @Column({ type: 'varchar', length: 128 })
  sessionToken: string;

  /** Wallet address this session was issued for (lowercase). */
  @Column({ type: 'varchar', length: 42 })
  walletAddress: string;

  /** Chain ID used during authentication. */
  @Column({ type: 'integer' })
  chainId: number;

  /** Session expiry; reject if now > expiresAt. */
  @Column({ type: 'datetime' })
  expiresAt: Date;

  /**
   * Set when this session is revoked (logout, rotation, forced revocation).
   * Null means the session is still active (subject to expiry check).
   */
  @Column({ type: 'datetime', nullable: true })
  revokedAt: Date | null;

  /**
   * ID of the session this one replaced via rotation.
   * Null for sessions created on initial login.
   */
  @Column({ type: 'uuid', nullable: true })
  rotatedFromSessionId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}