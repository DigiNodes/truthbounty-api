import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
  Check,
} from 'typeorm';

/**
 * One immutable version in an evidence item's history.
 *
 * Append-only: EvidenceReplaced creates a new row rather than mutating an
 * existing one, so version history is always fully reconstructable and a
 * removal never destroys prior versions.
 */
@Entity('v2_project_evidence_version', {
  foreignKeys: [
    {
      columnNames: ['evidenceId'],
      referencedTableName: 'v2_project_evidence',
      referencedColumnNames: ['evidenceId'],
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
  ],
})
@Unique('uq_v2_evidence_version', ['evidenceId', 'version'])
@Unique('uq_v2_evidence_version_event', ['eventTxHash', 'eventLogIndex'])
@Index(['evidenceId'])
@Check('chk_v2_evidence_version_number_positive', `"version" > 0`)
@Check('chk_v2_evidence_v_version_positive', '"version" > 0')
@Check('chk_v2_evidence_v_log_nonneg', '"eventLogIndex" >= 0')
@Check('chk_v2_evidence_v_block_nonneg', '"blockNumber" >= 0')
@Check(
  'chk_v2_evidence_v_ids_present',
  'length("evidenceId") > 0 AND length("contentDigest") > 0 AND length("eventTxHash") = 66',
)
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

  /**
   * SHA-256 integrity hash of version-specific canonical fields.
   * Computed from: evidenceId, version, contentDigest, safeMetadataUri,
   * submittedBy, eventTxHash, eventLogIndex, blockNumber, previousVersionHash.
   * Excludes: id (UUID), createdAt (backend timestamp), integrityHash itself.
   * NULL during migration backfill phase; NOT NULL after enforcement.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  integrityHash: string | null;

  /**
   * Hash of the previous version, enabling cryptographic chain-of-custody.
   * NULL for version 1. For version N > 1, contains integrityHash of version N-1.
   * Enables detection of version history tampering.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  previousVersionHash: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
