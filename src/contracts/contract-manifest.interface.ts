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
 * - Release binding: every contract entry must carry the same releaseId as
 *   the manifest-level releaseId; mixed-release manifests are rejected.
 * - Deployment floor: every contract's deployBlock must be >= the manifest-
 *   level deploymentFloor to prevent stale/pre-release addresses.
 * - Proxy provenance: when any proxy field (proxyAdmin, implementationAddress,
 *   implementationCodeHash) is present, all three must be present (all-or-
 *   nothing). An implementation code hash mismatch triggers a fail-closed
 *   rejection during on-chain verification.
 */

/** Allowed Optimism chain IDs. */
export const ALLOWED_CHAIN_IDS = [10, 11155420] as const;
export type AllowedChainId = (typeof ALLOWED_CHAIN_IDS)[number];

/**
 * Default maximum age of a manifest in days before it is considered stale.
 * Operators can override via MANIFEST_MAX_AGE_DAYS env var.
 */
export const DEFAULT_MANIFEST_MAX_AGE_DAYS = 90;

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
   */
  topic0?: string;
}

/**
 * Optional proxy / implementation provenance block.
 *
 * When any one of these fields is present, all three must be present
 * (all-or-nothing). When the on-chain code check is enabled the service will
 * also verify that the bytecode hash at implementationAddress matches
 * implementationCodeHash.
 */
export interface ManifestProxyProvenance {
  /**
   * EIP-55 checksummed address of the proxy admin (ProxyAdmin contract or
   * multisig that controls upgrades).
   */
  proxyAdmin: string;
  /**
   * EIP-55 checksummed address of the current implementation contract behind
   * the proxy.
   */
  implementationAddress: string;
  /**
   * keccak256 hex digest of the implementation contract's deployed bytecode.
   * Used to detect implementation swaps that have not been reflected in the
   * manifest.
   */
  implementationCodeHash: string;
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
  /**
   * Release identifier that this contract belongs to.
   * Must match the manifest-level releaseId; mixed-release manifests are
   * rejected.
   * Optional on the entry — the manifest-level releaseId is used when
   * per-entry releaseId is absent (backwards compat).
   */
  releaseId?: string;
  /**
   * Optional proxy / implementation provenance.
   * When any sub-field is present, all three (proxyAdmin, implementationAddress,
   * implementationCodeHash) must be present.
   */
  proxy?: ManifestProxyProvenance;
}

/** Top-level structure of the contract address manifest JSON file. */
export interface ContractAddressManifest {
  /**
   * Semantic version of this manifest schema/content.
   * Used to detect stale manifests or rollback scenarios.
   */
  version: string;
  /**
   * Opaque release identifier — e.g. "rel-opsepolia-20261015-v2".
   * Must be a non-empty string. All contracts in this manifest belong to this
   * release; cross-release manifests are rejected at validation time.
   */
  releaseId: string;
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
  /**
   * Minimum deploy block that any contract in this manifest is permitted to
   * have. Contracts with deployBlock < deploymentFloor are rejected.
   * Must be a non-negative integer.
   */
  deploymentFloor: number;
  /** The set of contracts registered in this manifest. */
  contracts: ManifestContractEntry[];
}

/** Result of validating a single manifest contract entry. */
export interface ManifestContractValidationResult {
  name: string;
  address: string;
  valid: boolean;
  errors: string[];
}

/** Aggregated result of a full manifest validation run. */
export interface ManifestValidationReport {
  valid: boolean;
  version: string;
  releaseId: string;
  chainId: number;
  contractCount: number;
  contractResults: ManifestContractValidationResult[];
  /** All error strings collected across the manifest. */
  errors: string[];
  /** Age of the manifest in days at validation time (informational). */
  manifestAgedays?: number;
}
