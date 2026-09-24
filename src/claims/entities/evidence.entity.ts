import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Claim } from './claim.entity';
import { EvidenceVersion } from './evidence-version.entity';

@Entity('evidences')
@Index(['claimId'])
export class Evidence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  claimId: string;

  @ManyToOne(() => Claim, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'claimId' })
  claim: Claim;

  @Column({ default: 1 })
  latestVersion: number;

  @Column({ default: false })
  isHidden: boolean;

  // Event-derived on-chain registration state.
  // Contracts emit facts -> the indexer projects them -> the API serves these
  // projections. onChainRegistered records whether the indexer has observed
  // the evidence being registered on-chain for this projectable aggregate.
  @Column({ type: 'boolean', default: false })
  onChainRegistered: boolean;

  @Column({ type: 'numeric', nullable: true })
  blockNumber: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true })
  transactionHash: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => EvidenceVersion, (version) => version.evidence, {
    cascade: true,
  })
  versions: EvidenceVersion[];
}
