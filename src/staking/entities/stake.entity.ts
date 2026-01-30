import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity()
@Index(['walletAddress', 'claimId'], { unique: true })
export class Stake {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  walletAddress: string;

  @Column()
  claimId: string;

  @Column({ type: 'decimal', precision: 78, scale: 0 })
  amount: string; // store as string (big numbers!)

  @Column()
  lastTxHash: string;

  @Column()
  updatedAt: Date;
}
