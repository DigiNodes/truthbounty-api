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

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => EvidenceVersion, (version) => version.evidence, { cascade: true })
  versions: EvidenceVersion[];
}