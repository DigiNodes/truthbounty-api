import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { StakingEventType } from "../types/staking-event.type";

@Entity()
@Index(['txHash'], { unique: true })
export class StakeEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  walletAddress: string;

  @Column()
  claimId: string;

  @Column({
    type: 'enum',
    enum: StakingEventType,
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
