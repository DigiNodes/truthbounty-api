import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * One immutable version in an evidence item's history.
 *
 * Append-only: EvidenceReplaced creates a new row rather than mutating an
 * existing one, so version history is always fully reconstructable and a
 * removal never destroys prior versions.
 */
@Entity('v2_project_evidence_version')
@Unique('uq_v2_evidence_version', ['evidenceId', 'version'])
@Unique('uq_v2_evidence_version_event', ['eventTxHash', 'eventLogIndex'])
@Index(['evidenceId'])
export class ProjectEvidenceVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 128 })
  evidenceId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'varchar', length: 66 })
  contentDigest: string;

  /**
   * Non-authoritative pointer to off-chain content (e.g. an IPFS URI), taken
   * verbatim from the event. Never fetched, resolved, or trusted as fact by
   * the API -- only the content digest carries integrity meaning.
   */
  @Column({ type: 'varchar', length: 512, nullable: true })
  safeMetadataUri: string | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  submittedBy: string | null;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @Column({ type: 'bigint' })
  blockNumber: string;

  @CreateDateColumn()
  createdAt: Date;
}
