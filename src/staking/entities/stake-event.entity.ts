import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { StakingEventType } from '../types/staking-event.type';

@Entity()
@Index(['txHash'], { unique: true })
@Index(['claimId'])
@Index(['walletAddress'])
@Index(['timestamp'])
@Index(['blockNumber'])
@Index(['claimId', 'walletAddress'])
export class StakeEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  walletAddress: string;

  @Column()
  claimId: string;

  @Column({
    type: 'varchar',
  })
  type: StakingEventType;

  @Column({ type: 'decimal', precision: 78, scale: 0 })
  amount: string;

  @Column()
  txHash: string;

  @Column()
  blockNumber: number;

  @Column()
  timestamp: Date;
}
