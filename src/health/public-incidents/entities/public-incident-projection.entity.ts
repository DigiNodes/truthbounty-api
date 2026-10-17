import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  PublicIncidentComponent,
  PublicIncidentImpact,
  PublicIncidentStatus,
} from '../public-incidents.dto';

export interface PostIncidentLinkItem {
  title: string;
  url: string;
}

export interface PublicationHistoryItem {
  id: string;
  status: PublicIncidentStatus;
  message: string;
  publishedAt: string;
  affectedComponents: PublicIncidentComponent[];
}

@Entity('public_incident_projections')
@Index(['status'])
@Index(['isApproved'])
@Index(['isDraft'])
@Index(['publishedAt'])
@Index(['createdAt'])
@Index(['isApproved', 'isDraft'])
export class PublicIncidentProjectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  incidentId: string | null;

  @Column({ length: 200, nullable: true })
  slug: string | null;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'varchar', default: 'investigating' })
  status: PublicIncidentStatus;

  @Column({ type: 'varchar', default: 'minor' })
  impact: PublicIncidentImpact;

  @Column({ type: 'json', default: () => "'[]'" })
  affectedComponents: PublicIncidentComponent[];

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'text', nullable: true })
  mitigation: string | null;

  @Column({ type: 'json', nullable: true })
  postIncidentLinks: PostIncidentLinkItem[] | null;

  @Column({ type: 'json', default: () => "'[]'" })
  publicationHistory: PublicationHistoryItem[];

  @Column({ type: 'boolean', default: false })
  isApproved: boolean;

  @Column({ type: 'boolean', default: true })
  isDraft: boolean;

  @Column({ nullable: true })
  approvedBy: string | null;

  @Column({ nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'integer', default: 1 })
  publicationSequence: number;

  @Column()
  startedAt: Date;

  @Column({ nullable: true })
  publishedAt: Date | null;

  @Column({ nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
