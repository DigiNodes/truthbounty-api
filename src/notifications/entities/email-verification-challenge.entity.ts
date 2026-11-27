import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Lifecycle states for an email ownership challenge.
 *
 * PENDING   – challenge issued, awaiting confirmation.
 * VERIFIED  – the user clicked/submitted the correct token within the TTL.
 * EXPIRED   – the TTL passed before confirmation; treated the same as revoked
 *             for delivery-gate purposes.
 * REVOKED   – superseded by a newer challenge for the same user, or
 *             explicitly invalidated by an address change.
 */
export type EmailVerificationState =
  | 'PENDING'
  | 'VERIFIED'
  | 'EXPIRED'
  | 'REVOKED';

/**
 * EmailVerificationChallenge
 *
 * One row per outstanding or historical challenge.  When a user requests a
 * new address (or re-requests a resend), any existing PENDING challenge is
 * set to REVOKED before the new row is inserted, so at most one PENDING
 * challenge exists per user at any time.
 *
 * Security notes:
 * - `tokenHash` stores the SHA-256 hex digest of the raw token; the
 *   plaintext token is never persisted.
 * - `pendingEmailAddress` is the address under verification; the already-
 *   confirmed address (if any) stays in `NotificationPreference.emailAddress`
 *   until this row reaches VERIFIED state.
 * - `emailAddress` is never written to logs (see EmailVerificationService).
 * - Cross-user substitution is prevented by scoping lookups on (userId, tokenHash).
 */
@Entity('email_verification_challenges')
@Index(['userId', 'state'])
@Index(['tokenHash'], { unique: true, where: `"state" = 'PENDING'` })
export class EmailVerificationChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Owner of the pending address change. */
  @Column({ type: 'varchar' })
  @Index()
  userId: string;

  /**
   * SHA-256 hex of the raw plaintext token.
   * Not unique globally (a revoked hash can re-appear across resets), but
   * the partial unique index above enforces uniqueness among PENDING rows.
   */
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  /**
   * Email address under verification.
   * Written at challenge creation; promoted to NotificationPreference.emailAddress
   * on VERIFIED transition.
   */
  @Column({ type: 'varchar' })
  pendingEmailAddress: string;

  /** Current lifecycle state. */
  @Column({ type: 'varchar', default: 'PENDING' })
  state: EmailVerificationState;

  /** Absolute expiry. The challenge must be confirmed before this time. */
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  /** Set when the user confirms the token successfully. */
  @Column({ type: 'timestamp', nullable: true })
  confirmedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
