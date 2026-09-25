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
 * Registered contract address + approved ABI artifact version.
 *
 * V2-BE-011 depends on V2-BE-008 ("Import Canonical Contract Release
 * Artifacts"), which has not merged and has no frozen interface yet. This
 * entity is a deliberately minimal stand-in scoped to exactly what V2-BE-011
 * needs to fail closed on unapproved sources: an allow-list of
 * (chainId, contractAddress) pairs pinned to one approved ABI + version.
 * It is expected to be replaced or reconciled once V2-BE-008 lands; see the
 * PR description for the residual rework this implies.
 */
@Entity('v2_contract_artifacts')
@Unique('uq_v2_contract_artifact_address', ['chainId', 'contractAddress'])
@Index(['isApproved'])
@Check('chk_v2_artifact_chain_positive', '"chainId" > 0')
@Check(
  'chk_v2_artifact_version_present',
  'length("artifactVersion") > 0 AND length("contractAddress") > 0',
)
export class ContractArtifact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'varchar', length: 42 })
  contractAddress: string;

  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  /** Minimal ABI: only the event fragments this pipeline needs to decode. */
  @Column({ type: 'json' })
  abi: unknown[];

  /**
   * Fail-closed gate. An address with no row, or a row where this is false,
   * is never decoded; its logs are quarantined as unregistered.
   */
  @Column({ type: 'boolean', default: false })
  isApproved: boolean;

  @CreateDateColumn()
  registeredAt: Date;
}
