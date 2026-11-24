/**
 * RPC Provider Quorum + Divergence Detection — V2-BE-051
 *
 * Read-side only. Never touches CanonicalEvent, never mutates protocol
 * state. It only decides whether a given provider's answer is *safe to
 * trust* relative to the quorum; the caller (indexer, startup validation,
 * health) decides what to do.
 */

/** The five independent signals compared across providers. */
export enum QuorumSignal {
  CHAIN_ID = 'CHAIN_ID',
  FINALIZED_HEAD = 'FINALIZED_HEAD',
  BLOCK_HASH = 'BLOCK_HASH',
  RECEIPT_STATUS = 'RECEIPT_STATUS',
  CONTRACT_CODE_HASH = 'CONTRACT_CODE_HASH',
}

/** Why a provider was marked divergent / quarantined. */
export enum DivergenceKind {
  /** Chain ID does not match the configured canonical chain. */
  WRONG_CHAIN = 'WRONG_CHAIN',
  /** Provider's finalized head is materially behind the quorum. */
  LAG = 'LAG',
  /** Provider returned a different block hash at the same height. */
  FORK_DIVERGENCE = 'FORK_DIVERGENCE',
  /** Provider returned a differing receipt status for the same tx. */
  RECEIPT_DIVERGENCE = 'RECEIPT_DIVERGENCE',
  /** Provider returned differing bytecode for the same contract address. */
  CODE_DIVERGENCE = 'CODE_DIVERGENCE',
  /** Provider did not respond within the timeout budget. */
  TIMEOUT = 'TIMEOUT',
  /** Provider rejected the request with a rate-limit response. */
  RATE_LIMITED = 'RATE_LIMITED',
  /** Provider threw an unexpected error. */
  ERROR = 'ERROR',
}

/**
 * Bounded, explicit quorum policy.
 * Every field has a hard default; no field is optional at runtime.
 */
export interface QuorumPolicy {
  /**
   * Minimum number of providers that must be reachable and agree for any
   * quorum decision to be considered valid. If fewer than `minAgreement`
   * providers agree, the quorum layer fails closed.
   */
  minAgreement: number;
  /**
   * Absolute cap on the number of providers we ever compare. Bounds the
   * cost of any quorum check.
   */
  maxProviders: number;
  /**
   * A provider whose finalized head lags the quorum head by more than this
   * many blocks is classified as LAG and quarantined. 0 disables the check.
   */
  maxHeadLagBlocks: number;
  /**
   * Per-call timeout in milliseconds. On timeout the provider is
   * classified TIMEOUT.
   */
  timeoutMs: number;
  /**
   * How long (ms) a quarantined provider must remain divergent before it
   * is allowed to participate again. Recovery requires fresh agreement.
   */
  quarantineMs: number;
  /**
   * Number of consecutive fresh agreements required for a quarantined
   * provider to be considered recovered. Minimum 1.
   */
  recoveryAgreementsRequired: number;
}

/** Default policy applied when none is supplied via config. */
export const DEFAULT_QUORUM_POLICY: QuorumPolicy = {
  minAgreement: 2,
  maxProviders: 5,
  maxHeadLagBlocks: 8,
  timeoutMs: 5_000,
  quarantineMs: 60_000,
  recoveryAgreementsRequired: 2,
};

/** A single provider as observed by the quorum layer. */
export interface QuorumProvider {
  /** Stable identifier — sanitized URL is the safest default. */
  id: string;
  /** Redacted URL suitable for logs / API responses. */
  sanitizedUrl: string;
  /** Function that returns this provider's observation of one signal. */
  observe: (signal: QuorumSignal, params?: QuorumObservationParams) => Promise<unknown>;
}

/** Params passed to `observe` when a signal needs context (height, tx, code). */
export interface QuorumObservationParams {
  blockNumber?: bigint;
  txHash?: string;
  contractAddress?: string;
}

/** The aggregated verdict returned by a quorum check. */
export interface QuorumVerdict {
  /** Whether quorum was satisfied for the requested signal. */
  accepted: boolean;
  /** The agreed value (present only when `accepted === true`). */
  value?: unknown;
  /** Which providers agreed. */
  agreedProviders: string[];
  /** Providers that disagreed or could not be reached. */
  divergentProviders: Array<{
    id: string;
    sanitizedUrl: string;
    kind: DivergenceKind;
    detail?: string;
  }>;
  /** Which signal this verdict is for. */
  signal: QuorumSignal;
  /** The policy that produced this verdict — echoed for audit. */
  policy: QuorumPolicy;
}

/** In-memory record of a provider's quarantine state. */
export interface QuarantineRecord {
  providerId: string;
  sanitizedUrl: string;
  kind: DivergenceKind;
  quarantinedAt: number;
  /** Consecutive fresh agreements observed since quarantine began. */
  freshAgreements: number;
}
