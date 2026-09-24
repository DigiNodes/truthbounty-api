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

@Entity('evidence_flags')
@Index(['evidenceId'])
export class EvidenceFlag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  evidenceId: string;

  @ManyToOne(() => Evidence, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'evidenceId' })
  evidence: Evidence;

  // reason codes: e.g. 'suspicious' | 'spam' | 'invalid'
  @Column()
  reason: string;

  // who flagged (admin id or moderator identifier)
  @Column({ nullable: true })
  flaggedBy?: string;

  @Column({ default: false })
  isModerator: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
