import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, Unique } from 'typeorm';

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

  @Column({ name: 'proof', type: 'json', nullable: true })
  proof?: any;
}
