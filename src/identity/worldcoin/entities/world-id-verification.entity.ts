import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * WorldIdVerification
 *
 * Retention policy: raw ZK proof bytes are NOT stored.  Only a SHA-256
 * digest of the proof is persisted in `proofHash` for audit traceability.
 * This satisfies the proof data retention requirement from the security audit
 * (issue #460) without retaining cryptographic material that could expose
 * user identity linkage across contexts.
 */
@Entity('world_id_verifications')
@Unique(['nullifierHash'])
export class WorldIdVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'nullifier_hash', unique: true })
  @Index()
  nullifierHash: string;

  @Column({ name: 'verification_level' })
  verificationLevel: string;

  @Column({ name: 'worldcoin_app_id' })
  worldcoinAppId: string;

  @Column({ name: 'worldcoin_action' })
  worldcoinAction: string;

  @CreateDateColumn({ name: 'verified_at' })
  verifiedAt: Date;

  @Column({ name: 'merkle_root', nullable: true })
  merkleRoot?: string;

  /**
   * SHA-256 hex digest of the raw ZK proof string.
   * Stored for audit purposes only — the raw proof is never persisted.
   */
  @Column({ name: 'proof_hash', nullable: true })
  proofHash?: string;

  // NOTE: The `proof` column has been intentionally removed.
  // Raw ZK proof bytes are NOT stored anywhere in this system.
  // See retention policy in the class-level JSDoc above.
}
