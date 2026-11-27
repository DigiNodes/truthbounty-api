import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Persisted support request with privacy-safe retention and encrypted contact details.
 *
 * PREWAVE-BE-106 (#807): Durable support request storage with:
 * - Keyed fingerprint for duplicate detection (not reversible base64)
 * - Encrypted contact and description fields for privacy
 * - 30-day retention policy with scheduled purge
 * - Atomic duplicate and quota checks across replicas
 * - Authorization boundary: only support staff can read/list/delete
 *
 * Privacy and security properties:
 * - Contact and description are encrypted at rest
 * - Fingerprint is a keyed hash, not reversible to original content
 * - Support staff access required for all reads
 * - Public submitters cannot enumerate or fetch requests
 * - Retention purge removes expired records and fingerprints
 */
@Entity('support_requests')
@Index(['fingerprintKey'], { unique: true })
@Index(['expiresAt'])
@Index(['createdAt'])
export class SupportRequest {
  /**
   * UUID primary key for the support request.
   */
  @PrimaryColumn('uuid')
  id: string;

  /**
   * Human-readable reference code for the request (e.g., SUP-ABC123).
   * Returned to the submitter for tracking purposes.
   */
  @Column({ type: 'varchar', length: 32, unique: true })
  @Index()
  reference: string;

  /**
   * Support category: bug, question, account, technical, content, other.
   */
  @Column({ type: 'varchar', length: 32 })
  category: string;

  /**
   * Encrypted contact information (email, wallet handle, or user ID).
   * Decrypted only by authorized support staff.
   */
  @Column({ type: 'text' })
  encryptedContact: string;

  /**
   * Encrypted description of the support request.
   * Decrypted only by authorized support staff.
   */
  @Column({ type: 'text' })
  encryptedDescription: string;

  /**
   * Optional release or build identifier (stored in plaintext).
   */
  @Column({ type: 'varchar', length: 120, nullable: true })
  release?: string;

  /**
   * Safe diagnostic references (stored as JSON array).
   * Only approved prefixes allowed: requestId, traceId, release, claimId, etc.
   */
  @Column({ type: 'jsonb', default: '[]' })
  diagnostics: string[];

  /**
   * Keyed fingerprint for duplicate detection.
   * Computed from normalized fields using a cryptographic hash.
   * Not reversible to original content.
   */
  @Column({ type: 'varchar', length: 64, unique: true })
  fingerprintKey: string;

  /**
   * Request status: submitted, duplicate, expired, deleted.
   */
  @Column({
    type: 'varchar',
    length: 16,
    default: 'submitted',
  })
  status: 'submitted' | 'duplicate' | 'expired' | 'deleted';

  /**
   * Whether this request is a duplicate of another.
   */
  @Column({ type: 'boolean', default: false })
  duplicate: boolean;

  /**
   * Reference to the original request if this is a duplicate.
   */
  @Column({ type: 'uuid', nullable: true })
  duplicateOf?: string | null;

  /**
   * Timestamp when the request expires (for retention purge).
   * Set to createdAt + retentionDays at creation time.
   */
  @Column({ type: 'timestamptz' })
  @Index()
  expiresAt: Date;

  /**
   * Number of days to retain the request (default: 30).
   */
  @Column({ type: 'int', default: 30 })
  retentionDays: number;

  /**
   * Timestamp when the request was created.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /**
   * Timestamp when the request was last updated.
   */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
