import { Readable } from 'stream';

export interface IpfsAddResult {
  /** Canonical CIDv1 (raw codec, SHA-256 multihash) for the uploaded bytes. */
  cid: string;
  size: number;
  path?: string;
}

export interface IpfsProvider {
  add(stream: Readable, opts?: { filename?: string }): Promise<IpfsAddResult>;
  getUrl?(cid: string): string | undefined;
}

export const IPFS_PROVIDER = 'IPFS_PROVIDER';
