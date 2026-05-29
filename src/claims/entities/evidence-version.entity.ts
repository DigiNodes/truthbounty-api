import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Evidence } from './evidence.entity';

@Entity('evidence_versions')
@Index(['evidenceId'])
@Index(['evidenceId', 'version'])
export class EvidenceVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  evidenceId: string;

  @ManyToOne(() => Evidence, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'evidenceId' })
  evidence: Evidence;

  @Column({ type: 'int' })
  version: number;

  @Column()
  cid: string;

  @Column({ nullable: true })
  hash: string;

  @Column({ nullable: true })
  submittedBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
