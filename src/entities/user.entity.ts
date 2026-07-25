import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  walletAddress: string;

  @Column({ type: 'int', default: 0 })
  reputation: number;

  @Column({ default: false })
  worldcoinVerified: boolean;

  @Column({ type: 'datetime', nullable: true })
  worldcoinVerifiedAt: Date | null;

  @OneToMany('Wallet', 'user', { cascade: true })
  wallets: any[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
