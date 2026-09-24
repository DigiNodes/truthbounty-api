import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum IncidentSeverity {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export enum IncidentStatus {
  OPEN = 'open',
  INVESTIGATING = 'investigating',
  CONTAINED = 'contained',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export enum IncidentClassification {
  SECURITY_BREACH = 'security_breach',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  ABUSE_REPORT = 'abuse_report',
  SYSTEM_FAILURE = 'system_failure',
  GOVERNANCE_ISSUE = 'governance_issue',
  POLICY_VIOLATION = 'policy_violation',
  OTHER = 'other',
}

@Entity('incidents')
@Index(['status'])
@Index(['severity'])
@Index(['classification'])
@Index(['assignedTo'])
@Index(['createdAt'])
@Index(['status', 'severity'])
export class Incident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 200 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar' })
  classification: IncidentClassification;

  @Column({ type: 'varchar' })
  severity: IncidentSeverity;

  @Column({ type: 'varchar', default: IncidentStatus.OPEN })
  status: IncidentStatus;

  @Column({ nullable: true })
  assignedTo: string | null;

  @Column({ nullable: true })
  reportedBy: string | null;

  @Column({ nullable: true })
  relatedEntityType: string | null;

  @Column({ nullable: true })
  relatedEntityId: string | null;

  @Column({ type: 'json', nullable: true })
  investigationNotes: Array<{
    author: string;
    content: string;
    createdAt: string;
  }> | null;

  @Column({ type: 'json', nullable: true })
  resolution: {
    summary: string;
    actions: string[];
    resolvedBy: string;
    resolvedAt: string;
  } | null;

  @Column({ type: 'json', nullable: true })
  postIncidentReport: {
    rootCause: string;
    impact: string;
    preventiveActions: string[];
    lessonsLearned: string[];
    reportAuthor: string;
    completedAt: string;
  } | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ nullable: true })
  resolvedAt: Date | null;
}
