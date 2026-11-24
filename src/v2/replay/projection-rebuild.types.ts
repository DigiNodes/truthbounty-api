/** PREWAVE-BE-002 — deterministic full replay / projection rebuild. */

export type RebuildMode =
  | 'dry-run'
  | 'rebuild'
  | 'resume'
  | 'verify'
  | 'cutover'
  | 'compare';

export interface ReplayBinding {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

export interface ReplayCheckpoint {
  chainId: number;
  /** Last successfully applied canonical event order key. */
  lastBlockNumber: string;
  lastLogIndex: number;
  lastEventId: string | null;
  updatedAt: string;
}

export interface ProjectionDigestMetadata {
  projector: string;
  schema: string;
  releaseId: string;
  chainId: number;
  deploymentBlock: number;
  artifactChecksum: string;
  algorithm: string;
  canonicalVersion: string;
  excludedFields: string[];
  rowCount: number;
  dataDigest: string;
  envelopeDigest: string;
  createdAt?: string;
}

export interface ProjectionDigest {
  projector: string;
  rowCount: number;
  /** sha256 hex of canonical sorted projection payload. */
  digest: string;
  /** Target schema identity (e.g. 'replay_shadow', 'public'). */
  schema?: string;
  /** Release identifier (e.g. 'v2.1.0'). */
  releaseId?: string;
  /** Network chain ID (e.g. 11155420). */
  chainId?: number;
  /** Deployment block number. */
  deploymentBlock?: number;
  /** Authoritative smart contract / deployment artifact checksum. */
  artifactChecksum?: string;
  /** Composite envelope digest binding data digest with release, schema, and chain context. */
  envelopeDigest?: string;
  /** Full audit metadata for this projection digest. */
  metadata?: ProjectionDigestMetadata;
}

export interface ProjectionComparisonDiff {
  projector: string;
  status: 'match' | 'mismatch' | 'missing_in_rebuild' | 'missing_in_live';
  rebuildRowCount?: number;
  liveRowCount?: number;
  rebuildDigest?: string;
  liveDigest?: string;
  rebuildEnvelopeDigest?: string;
  liveEnvelopeDigest?: string;
  details?: string;
}

export interface ProjectionComparisonReport {
  schemaVersion: 1;
  comparedAt: string;
  equivalent: boolean;
  binding?: Partial<ReplayBinding>;
  rebuildSchema?: string;
  liveSchema?: string;
  projectorsCount: number;
  diffs: ProjectionComparisonDiff[];
  errors: string[];
}

export class MissingProjectionDigestError extends Error {
  public readonly code = 'MISSING_PROJECTION_DIGEST';
  public readonly projector: string;
  public readonly schema?: string;
  public readonly actionableAdvice: string;

  constructor(projector: string, schema?: string, customAdvice?: string) {
    const advice =
      customAdvice ??
      `Projection digest for '${projector}'${schema ? ` in schema '${schema}'` : ''} is missing. ` +
      `Ensure the projection has been snapshotted or rebuilt before verification or cutover.`;
    super(
      `Missing projection digest for projector '${projector}'${schema ? ` in schema '${schema}'` : ''}. ${advice}`,
    );
    this.name = 'MissingProjectionDigestError';
    this.projector = projector;
    this.schema = schema;
    this.actionableAdvice = advice;
    Object.setPrototypeOf(this, MissingProjectionDigestError.prototype);
  }
}

export class ProjectionDigestMismatchError extends Error {
  public readonly code = 'PROJECTION_DIGEST_MISMATCH';
  public readonly projector: string;
  public readonly expectedDigest: string;
  public readonly actualDigest: string;
  public readonly actionableAdvice: string;

  constructor(
    projector: string,
    expectedDigest: string,
    actualDigest: string,
    customAdvice?: string,
  ) {
    const advice =
      customAdvice ??
      `Projection digest mismatch for '${projector}'. Rebuild state drifted from expected live state. ` +
      `Inspect projection row drift and do not cut over.`;
    super(
      `Projection digest mismatch for projector '${projector}'. Expected: ${expectedDigest}, got: ${actualDigest}. ${advice}`,
    );
    this.name = 'ProjectionDigestMismatchError';
    this.projector = projector;
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
    this.actionableAdvice = advice;
    Object.setPrototypeOf(this, ProjectionDigestMismatchError.prototype);
  }
}

export class ProjectionBindingMismatchError extends Error {
  public readonly code = 'PROJECTION_BINDING_MISMATCH';
  public readonly property: string;
  public readonly expected: unknown;
  public readonly actual: unknown;
  public readonly actionableAdvice: string;

  constructor(
    property: string,
    expected: unknown,
    actual: unknown,
    customAdvice?: string,
  ) {
    const advice =
      customAdvice ??
      `Projection binding mismatch for '${property}'. ` +
      `Ensure both environments are running the same release, chain, and contract artifact.`;
    super(
      `Projection binding mismatch for '${property}'. Expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}. ${advice}`,
    );
    this.name = 'ProjectionBindingMismatchError';
    this.property = property;
    this.expected = expected;
    this.actual = actual;
    this.actionableAdvice = advice;
    Object.setPrototypeOf(this, ProjectionBindingMismatchError.prototype);
  }
}

export interface ReplayReport {
  schemaVersion: 1;
  mode: RebuildMode;
  binding: ReplayBinding;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  resumable: boolean;
  eventsRead: number;
  eventsApplied: number;
  eventsSkipped: number;
  checkpoint: ReplayCheckpoint | null;
  digests: ProjectionDigest[];
  /** true only when verify/cutover compared equal digests */
  digestsMatch: boolean | null;
  cutoverApplied: boolean;
  errors: string[];
  /** Never includes secrets, signatures, evidence, or auth material. */
  notes: string[];
}

export interface CanonicalEventLike {
  id: string;
  chainId: number;
  contractAddress: string;
  artifactVersion: string;
  eventName: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  payload: Record<string, unknown>;
}

export interface ProjectorAdapter {
  name: string;
  /** Apply one event; must be idempotent for the same (txHash, logIndex). */
  apply(event: CanonicalEventLike): Promise<'applied' | 'skipped' | 'anomaly'>;
  /** Deterministic snapshot of projected rows for digesting. */
  snapshot(): Promise<unknown[]>;
  /** Clear projection rows for isolated rebuild target (non-production only). */
  reset?(): Promise<void>;
  }
