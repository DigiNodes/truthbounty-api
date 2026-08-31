import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum EvidenceStatus {
  ACTIVE = 'active',
  REMOVED = 'removed',
}

/**
 * Current-state projection of one piece of evidence for a claim.
 *
 * This is a read model only: every field is derived from
 * EvidenceRegistered/EvidenceReplaced/EvidenceRemoved canonical events. The
 * API never writes here except by replaying those events, so it never
 * becomes a second source of truth alongside the (legacy, superseded)
 * directly-writable `evidences` table this issue's scope replaces.
 */
@Entity('v2_project_evidence')
@Index(['claimId'])
export class ProjectEvidence {
  /** Deterministic id: derived from the claim + evidence slot the protocol assigns. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  evidenceId: string;

  @Column({ type: 'varchar', length: 66 })
  claimId: string;

  @Column({ type: 'int', default: 1 })
  currentVersion: number;

  @Column({ type: 'varchar', length: 16, default: EvidenceStatus.ACTIVE })
  status: EvidenceStatus;

  /** Content digest of the current (latest, non-removed) version. Not authoritative content. */
  @Column({ type: 'varchar', length: 66 })
  contentDigest: string;

  /** Ordering key of the most recently applied event, for keyset pagination. */
  @Column({ type: 'bigint' })
  lastEventBlockNumber: string;

  @Column({ type: 'int' })
  lastEventLogIndex: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
