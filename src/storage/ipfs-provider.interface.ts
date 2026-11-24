/**
 * Raw result a provider returns for a CID request. Providers must NOT follow
 * redirects or interpret status codes; the quorum service classifies them.
 */
export interface IpfsProviderResponse {
  /** HTTP-like status code (200 = success). */
  status: number;
  /** Returned bytes (only meaningful when status is 200). */
  bytes: Uint8Array;
}

export interface IpfsFetchOptions {
  signal: AbortSignal;
  maxBytes: number;
}

/**
 * A single IPFS retrieval provider (gateway, pinning service, node).
 * `id` is an operator-facing label only and never part of the canonical
 * evidence identity, which is the CID.
 */
export interface IpfsProvider {
  readonly id: string;
  fetch(cid: string, options: IpfsFetchOptions): Promise<IpfsProviderResponse>;
}
