import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';

/**
 * User Entity
 * 
 * Represents a verified user in the TruthBounty protocol.
 * Users can link multiple wallets across different chains.
 * Reputation is tracked to weight verification votes.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Primary wallet address for the user
   * This is the canonical identifier for the user
   */
  @Column({ unique: true })
  @Index()
  walletAddress: string;

  /**
   * User's reputation score (0-100)
   * Used to weight verification votes
   * Increases with accurate verifications, decreases with inaccurate ones
   */
  @Column({ type: 'int', default: 0 })
  reputation: number;

  /**
   * All wallets linked to this user across different chains
   */
  @OneToMany('Wallet', 'user', {
    cascade: true,
  })
  wallets: any[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
