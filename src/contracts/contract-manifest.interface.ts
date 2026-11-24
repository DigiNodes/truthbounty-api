/**
 * Typed interface for the canonical contract address manifest.
 *
 * The manifest is the authoritative, versioned record of every deployed
 * Optimism/EVM contract the indexer is allowed to observe. It is loaded at
 * startup from a checked-in JSON file (never hand-maintained at runtime) and
 * validated before the indexer accepts a single block.
 *
 * Design invariants
 * -----------------
 * - Fail closed: any schema violation, checksum mismatch, zero/dummy address,
 *   or missing field throws hard at startup; the app never runs with an
 *   unvalidated manifest.
 * - Immutable at runtime: the manifest is loaded once and never mutated;
 *   callers receive a deep-frozen copy.
 * - No alternate-chain paths: chainId must be an Optimism value (10 or
 *   11155420); other values are rejected.
 * - No backend-authoritative state: the manifest only tracks *where* to
 *   listen; it never carries settlement, reward, treasury, claim, or dispute
 *   state.
 * - Freshness guard: the manifest's publishedAt must not exceed
 *   MANIFEST_MAX_AGE_DAYS (default 90) days ago; stale manifests are
 *   rejected to prevent operators from deploying with outdated contract
 *   registrations.
 */

/** Allowed Optimism chain IDs. */
export const ALLOWED_CHAIN_IDS = [10, 11155420] as const;
export type AllowedChainId = (typeof ALLOWED_CHAIN_IDS)[number];

/**
 * Default maximum age of a manifest in days before it is considered stale.
 * Operators can override via MANIFEST_MAX_AGE_DAYS env var.
 */
export const DEFAULT_MANIFEST_MAX_AGE_DAYS = 90;

/**
 * Indexed parameter metadata for validation and drift detection.
 */
export interface IndexedParameterMetadata {
  /** Parameter name as it appears in the ABI. */
  name: string;
  /** Solidity type, e.g. "address", "uint256", "bytes32". */
  type: string;
  /** Zero-based position in the parameter list. */
  position: number;
}

/** A single ABI event fragment entry inside a manifest contract. */
export interface ManifestEventFragment {
  /** Event name, e.g. "Staked". */
  name: string;
  /**
   * Full event ABI fragment, e.g.
   * "event Staked(address indexed user, uint256 amount)".
   */
  abi: string;
  /**
   * Optional keccak256 topic-0 for this event, used to cross-check the ABI
   * fragment independently. Example: "0x...".
   * When present, must match ethers.id(canonicalAbiSignature).
   * 
   * REQUIRED for production manifests (post-Wave-9).
   * NULL for anonymous events (which do not emit topic0).
   */
  topic0?: string | null;
  /**
   * Whether this event is declared with the `anonymous` keyword.
   * Anonymous events do not emit topic0, allowing up to 4 indexed parameters
   * instead of the usual 3. Default: false.
   * 
   * REQUIRED for production manifests (post-Wave-9).
   */
  anonymous?: boolean;
  /**
   * Canonical signature for this event, e.g. "Transfer(address,address,uint256)".
   * Used for signature-based event keying instead of name-only keying.
   * 
   * REQUIRED for production manifests (post-Wave-9) to support overload detection.
   */
  signature?: string;
  /**
   * Indexed parameters metadata for drift detection and layout validation.
   * Order, types, and count must remain stable across manifest versions to
   * ensure log decoding compatibility.
   * 
   * REQUIRED for production manifests (post-Wave-9).
   */
  indexed?: IndexedParameterMetadata[];
}

/** A single contract entry inside the manifest. */
export interface ManifestContractEntry {
  /**
   * EIP-55 checksummed 20-byte hex address.
   * Regex: /^0x[a-fA-F0-9]{40}$/
   */
  address: string;
  /** Human-readable contract name used for logging only. */
  name: string;
  /** Block height from which this contract should be indexed. */
  deployBlock: number;
  /** SHA-256 hex digest of JSON.stringify(events) for tamper-detection. */
  abiChecksum: string;
  /** The ABI events this contract exposes for indexing. */
  events: ManifestEventFragment[];
}

/** Top-level structure of the contract address manifest JSON file. */
export interface ContractAddressManifest {
  /**
   * Semantic version of this manifest schema/content.
   * Used to detect stale manifests or rollback scenarios.
   */
  version: string;
  /**
   * Optimism chain ID this manifest targets.
   * Must be one of ALLOWED_CHAIN_IDS.
   */
  chainId: AllowedChainId;
  /**
   * ISO-8601 timestamp of the last time this manifest was published.
   * Used for freshness checks — must be within MANIFEST_MAX_AGE_DAYS days.
   */
  publishedAt: string;
  /**
   * SHA-256 hex digest of JSON.stringify(contracts) for whole-manifest
   * integrity verification.
   */
  manifestChecksum: string;
  /** The set of contracts registered in this manifest. */
  contracts: ManifestContractEntry[];
}

/** Result of validating a single manifest contract entry. */
export interface ManifestContractValidationResult {
  name: string;
  address: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Aggregated result of a full manifest validation run. */
export interface ManifestValidationReport {
  valid: boolean;
  version: string;
  chainId: number;
  contractCount: number;
  contractResults: ManifestContractValidationResult[];
  /** All error strings collected across the manifest. */
  errors: string[];
  /** All warning strings collected across the manifest. */
  warnings: string[];
  /** Age of the manifest in days at validation time (informational). */
  manifestAgedays?: number;
}
