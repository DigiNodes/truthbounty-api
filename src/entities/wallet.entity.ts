import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from './user.entity';

/**
 * Wallet Entity
 * 
 * Represents a blockchain wallet linked to a user.
 * Users can link multiple wallets across different chains (Ethereum, Optimism, Stellar, etc.)
 * Each (address, chain) combination must be unique across the entire system.
 */
@Entity('wallets')
@Unique(['address', 'chain'])
export class Wallet {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Wallet address (e.g., 0x123... for EVM chains)
   */
  @Column()
  @Index()
  address: string;

  /**
   * Blockchain network identifier
   * Examples: 'ethereum', 'optimism', 'stellar', 'polygon'
   */
  @Column()
  chain: string;

  /**
   * Reference to the user who owns this wallet
   */
  @Column()
  userId: string;

  @ManyToOne(() => User, (user) => user.wallets, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'userId' })
  user: User;

  /**
   * Timestamp when this wallet was linked to the user
   */
  @CreateDateColumn()
  linkedAt: Date;
}
