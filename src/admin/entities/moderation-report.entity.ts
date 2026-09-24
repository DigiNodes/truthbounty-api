import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum ReportType {
  FLAGGED_CLAIM = 'flagged_claim',
  REPORTED_USER = 'reported_user',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  DISPUTE_ESCALATION = 'dispute_escalation',
  CONTENT_REVIEW = 'content_review',
  ABUSE_REPORT = 'abuse_report',
  SPAM = 'spam',
  OTHER = 'other',
}

export enum ReportStatus {
  PENDING = 'pending',
  UNDER_REVIEW = 'under_review',
  INVESTIGATING = 'investigating',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

export enum ReportPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

@Entity('moderation_reports')
@Index(['status'])
@Index(['type'])
@Index(['priority'])
@Index(['assignedTo'])
@Index(['createdAt'])
@Index(['status', 'priority'])
export class ModerationReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  type: ReportType;

  @Column({ type: 'varchar', default: ReportStatus.PENDING })
  status: ReportStatus;

  @Column({ type: 'varchar', default: ReportPriority.MEDIUM })
  priority: ReportPriority;

  @Column({ length: 500 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ nullable: true })
  reportedBy: string | null;

  @Column({ nullable: true })
  reportedUser: string | null;

  @Column({ nullable: true })
  targetId: string | null;

  @Column({ nullable: true })
  targetType: string | null;

  @Column({ nullable: true })
  assignedTo: string | null;

  @Column({ type: 'json', nullable: true })
  evidence: Array<{
    type: string;
    value: string;
  }> | null;

  @Column({ type: 'json', nullable: true })
  resolution: {
    action: string;
    notes: string;
    resolvedBy: string;
    resolvedAt: string;
  } | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  resolvedAt: Date | null;
}
