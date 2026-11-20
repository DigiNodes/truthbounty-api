import { Injectable } from '@nestjs/common';
import { JsonRpcProvider } from 'ethers';
import { IndexerConfigService } from '../../config/indexer-config.service';

export const CANONICAL_CHAIN_HEADS = Symbol('CANONICAL_CHAIN_HEADS');

/** Provenance recorded on every checkpoint whose watermarks came from heads. */
export const PROVIDER_FINALITY_SOURCE =
  'provider:eth_getBlockByNumber(latest|safe|finalized)';

/** Default maximum age of an observed head snapshot before it is rejected. */
export const DEFAULT_MAX_HEAD_AGE_MS = 120_000;
/** Clock skew tolerated when a provider reports an observation time. */
const MAX_FUTURE_SKEW_MS = 5_000;

const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** The three finality boundaries as observed from one canonical chain. */
export interface CanonicalChainHeads {
  chainId: number;
  observedHead: bigint;
  safeHead: bigint;
  finalizedHead: bigint;
  /** Hash of the provider safe head, when the provider reported one. */
  safeBlockHash?: string | null;
  /** Hash of the provider finalized head, when the provider reported one. */
  finalizedBlockHash?: string | null;
  /** When the provider returned these heads. */
  observedAt: Date;
  /** Machine-readable source of the observation. */
  source: string;
}

/** Source of provider-reported chain heads (ethers v6 compatible). */
export interface ChainHeadRpc {
  getNetwork(): Promise<{ chainId: bigint | number }>;
  getBlock(
    tag: 'latest' | 'safe' | 'finalized',
  ): Promise<{ number: number; hash?: string | null } | null>;
}

/** Returns validated provider heads, or null when absent or unusable. */
export interface ChainHeadsProvider {
  getHeads(chainId: number, now?: Date): Promise<CanonicalChainHeads | null>;
}

function isBigInt(value: unknown): value is bigint {
  return typeof value === 'bigint';
}

function optionalHash(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value ?? null;
  return typeof value === 'string' && BLOCK_HASH_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Fail-closed validation for a provider head snapshot. A snapshot is accepted
 * only when it is chain-scoped, structurally well formed, ordered
 * `finalized <= safe <= observed`, and recently observed. Any defect returns
 * null so callers leave their finality watermarks untouched.
 */
export function validateChainHeads(
  value: CanonicalChainHeads | null | undefined,
  chainId: number,
  now: Date = new Date(),
  maxHeadAgeMs: number = DEFAULT_MAX_HEAD_AGE_MS,
): CanonicalChainHeads | null {
  if (!value || typeof value !== 'object') return null;
  if (value.chainId !== chainId || !Number.isInteger(chainId) || chainId <= 0) {
    return null;
  }
  if (
    !isBigInt(value.observedHead) ||
    !isBigInt(value.safeHead) ||
    !isBigInt(value.finalizedHead)
  ) {
    return null;
  }
  if (
    value.finalizedHead < 0n ||
    value.safeHead < value.finalizedHead ||
    value.observedHead < value.safeHead
  ) {
    return null;
  }
  if (!(value.observedAt instanceof Date)) return null;
  const observedAt = value.observedAt.getTime();
  if (!Number.isFinite(observedAt)) return null;
  const age = now.getTime() - observedAt;
  if (
    !Number.isFinite(maxHeadAgeMs) ||
    maxHeadAgeMs < 0 ||
    age > maxHeadAgeMs ||
    age < -MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  if (typeof value.source !== 'string' || value.source.length === 0) {
    return null;
  }
  const safeBlockHash = optionalHash(value.safeBlockHash);
  if (value.safeBlockHash != null && safeBlockHash === null) return null;
  const finalizedBlockHash = optionalHash(value.finalizedBlockHash);
  if (value.finalizedBlockHash != null && finalizedBlockHash === null) {
    return null;
  }
  return {
    chainId,
    observedHead: value.observedHead,
    safeHead: value.safeHead,
    finalizedHead: value.finalizedHead,
    safeBlockHash: safeBlockHash ?? null,
    finalizedBlockHash: finalizedBlockHash ?? null,
    observedAt: new Date(observedAt),
    source: value.source,
  };
}

/**
 * The authoritative head source for V2 ingestion: the provider's own
 * latest/safe/finality tags. No confirmation arithmetic is used here — the
 * provider is the only authority for the safe and finalized boundaries.
 * The RPC handle is created lazily so an unset RPC URL never breaks startup.
 */
@Injectable()
export class RpcChainHeadsProvider implements ChainHeadsProvider {
  private rpc: ChainHeadRpc | null = null;

  constructor(private readonly indexerConfig: IndexerConfigService) {}

  async getHeads(chainId: number, now: Date = new Date()) {
    const rpc = this.getRpc();
    if (!rpc) return null;

    try {
      const network = await rpc.getNetwork();
      if (Number(network.chainId) !== chainId) return null;
      const [latest, safe, finalized] = await Promise.all([
        rpc.getBlock('latest'),
        rpc.getBlock('safe'),
        rpc.getBlock('finalized'),
      ]);
      if (!latest || !safe || !finalized) return null;
      if (
        !Number.isSafeInteger(latest.number) ||
        !Number.isSafeInteger(safe.number) ||
        !Number.isSafeInteger(finalized.number) ||
        latest.number < 0
      ) {
        return null;
      }
      return validateChainHeads(
        {
          chainId,
          observedHead: BigInt(latest.number),
          safeHead: BigInt(safe.number),
          finalizedHead: BigInt(finalized.number),
          safeBlockHash: safe.hash ?? null,
          finalizedBlockHash: finalized.hash ?? null,
          observedAt: now,
          source: PROVIDER_FINALITY_SOURCE,
        },
        chainId,
        now,
      );
    } catch {
      return null;
    }
  }

  private getRpc(): ChainHeadRpc | null {
    if (this.rpc) return this.rpc;
    const url = this.indexerConfig.getEventIndexerConfig().rpcUrl;
    if (!url || typeof url !== 'string') return null;
    this.rpc = new JsonRpcProvider(url);
    return this.rpc;
  }
}
