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
 * One decoded call inside a proposal's `calls[]` (target, value, calldata).
 *
 * Per V2-BE-067 the read model must:
 *   - Keep exact calls decodable and checksummed.
 *   - Fail closed on unknown selectors.
 *   - Surface overloaded call signatures distinctly.
 *
 * Each row stores both the raw hex (checksummed) and, when decodable,
 * the parsed `functionName` + `args`. Rows where decoding was not possible
 * are still stored — but with `selectorUnknown = true` and no parsed args.
 */
@Entity('v2_governance_actions')
@Unique('uq_v2_gov_action_prop_log', [
  'chainId',
  'proposalId',
  'actionIndex',
  'logIndex',
])
@Index(['chainId', 'proposalId', 'actionIndex'])
@Index(['chainId', 'selector'])
@Check('chk_v2_gov_action_prop_nonneg', '"proposalId" >= 0')
@Check('chk_v2_gov_action_idx_nonneg', '"actionIndex" >= 0')
export class GovernanceAction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  chainId: number;

  @Column({ type: 'bigint' })
  proposalId: string;

  /** 0-based position within the proposal's `calls[]` array. */
  @Column({ type: 'int' })
  actionIndex: number;

  /** Checksummed target address (EIP-55). */
  @Column({ type: 'varchar', length: 42 })
  target: string;

  /** Value in wei, as a decimal string. */
  @Column({ type: 'varchar', length: 78 })
  valueWei: string;

  /** Exact calldata as emitted on-chain (0x-prefixed hex). */
  @Column({ type: 'text' })
  calldata: string;

  /** First 4 bytes of the calldata; null if calldata is shorter than 4 bytes. */
  @Column({ type: 'varchar', length: 10, nullable: true })
  selector: string | null;

  /**
   * Human-readable function signature when the selector was resolved
   * against the approved ABI (e.g. `transfer(address,uint256)`).
   * Null when unknown — this is the fail-closed signal.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  functionSignature: string | null;

  /**
   * True when the selector was not present in the approved ABI.
   * Downstream services must treat this as "cannot interpret" — never guess.
   */
  @Column({ type: 'boolean', default: false })
  selectorUnknown: boolean;

  /**
   * JSON-safe parsed arguments (bigint → decimal string), or null when
   * `selectorUnknown === true` or decoding threw.
   */
  @Column({ type: 'json', nullable: true })
  decodedArgs: Record<string, unknown> | null;

  /**
   * sha256(calldata) — a stable handle the API can echo back so consumers
   * can verify they received exactly what the chain emitted.
   */
  @Column({ type: 'varchar', length: 64 })
  calldataChecksum: string;

  /** Artefact version used when the calldata was decoded. */
  @Column({ type: 'varchar', length: 64 })
  artifactVersion: string;

  @CreateDateColumn()
  createdAt: Date;
}
