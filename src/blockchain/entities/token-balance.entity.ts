import { Entity, Column, PrimaryGeneratedColumn, Index, Unique } from 'typeorm';

@Entity('token_balances')
@Unique(['address', 'tokenAddress'])
export class TokenBalance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 42 })
  address: string;

  @Column({ name: 'token_address', length: 42 })
  tokenAddress: string;

  @Column({ type: 'decimal', precision: 36, scale: 18, default: 0 })
  balance: string;

  @Column({ name: 'last_updated', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  lastUpdated: Date;
}