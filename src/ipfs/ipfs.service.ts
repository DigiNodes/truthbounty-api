import { Inject, Injectable, Logger } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'stream';
import { IPFS_PROVIDER, IpfsAddResult, IpfsProvider } from './interfaces';

type AddressFamily = 'ipv4' | 'ipv6';
type GatewayUrlFailure =
  | 'invalid_type'
  | 'malformed_encoding'
  | 'unsafe_characters'
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_present'
  | 'unsupported_port'
  | 'private_host';

const blockedGatewayAddresses = new BlockList();
const blockedGatewaySubnets: Array<[string, number, AddressFamily]> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
];

for (const [address, prefix, family] of blockedGatewaySubnets) {
  blockedGatewayAddresses.addSubnet(address, prefix, family);
}

const isUnsafeHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const addressFamily = isIP(normalized);
  if (addressFamily === 4 || addressFamily === 6) {
    return blockedGatewayAddresses.check(
      normalized,
      addressFamily === 4 ? 'ipv4' : 'ipv6',
    );
  }

  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized === 'metadata.google.internal'
  );
};

/**
 * Detect C0/C1 control characters and HTML angle brackets in a raw provider
 * string. Implemented with char codes rather than a regex so the intent is
 * explicit and `no-control-regex` does not need to be suppressed.
 */
const hasUnsafeUrlCharacters = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x3c || code === 0x3e) return true; // '<' or '>'
  }
  return false;
};

/**
 * High-level IPFS service providing deterministic, provider-agnostic uploads.
 * - Accepts streams to remain memory-safe
 * - Returns deterministic content-addressed IDs (CID-like)
 */
@Injectable()
export class IpfsService {
  private readonly logger = new Logger(IpfsService.name);

  constructor(@Inject(IPFS_PROVIDER) private provider: IpfsProvider) {}

  async uploadStream(
    stream: Readable,
    filename?: string,
  ): Promise<IpfsAddResult> {
    this.logger.debug('Uploading stream to IPFS provider');
    const result = await this.provider.add(stream, { filename });
    return result;
  }

  async uploadBuffer(
    buffer: Buffer,
    filename?: string,
  ): Promise<IpfsAddResult> {
    const stream = Readable.from(buffer);
    return this.uploadStream(stream, filename);
  }

  getGatewayUrl(cid: string): string | undefined {
    if (typeof this.provider.getUrl !== 'function') return undefined;

    let raw: string | undefined;
    try {
      raw = this.provider.getUrl(cid);
    } catch (error) {
      this.logger.error('IPFS gateway provider failed (provider_error)');
      throw error;
    }

    if (!raw) return undefined;

    return this.sanitizeGatewayUrl(raw);
  }

  private logGatewayRejection(category: GatewayUrlFailure): void {
    this.logger.warn(`Rejected IPFS gateway URL (${category})`);
  }

  /**
   * Sanitize a gateway URL returned by an IPFS provider.
   * - Only allow http/https schemes
   * - Reject URLs containing control characters or angle brackets
   * - Return a normalized URL string or undefined for unsafe values
   */
  private sanitizeGatewayUrl(urlStr: string): string | undefined {
    if (typeof urlStr !== 'string') {
      this.logGatewayRejection('invalid_type');
      return undefined;
    }

    const raw = urlStr.trim();
    if (!raw) return undefined;

    if (hasUnsafeUrlCharacters(raw)) {
      this.logGatewayRejection('unsafe_characters');
      return undefined;
    }

    try {
      decodeURIComponent(raw);
    } catch {
      this.logGatewayRejection('malformed_encoding');
      return undefined;
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      this.logGatewayRejection('invalid_url');
      return undefined;
    }

    // Only allow http(s).
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      this.logGatewayRejection('unsupported_scheme');
      return undefined;
    }

    // Gateway URLs must not target private infrastructure or carry credentials.
    if (url.username || url.password) {
      this.logGatewayRejection('credentials_present');
      return undefined;
    }

    if (url.port !== '' && url.port !== '80' && url.port !== '443') {
      this.logGatewayRejection('unsupported_port');
      return undefined;
    }

    if (isUnsafeHostname(url.hostname)) {
      this.logGatewayRejection('private_host');
      return undefined;
    }

    // Return normalized URL (this will percent-encode parts as needed).
    return url.toString();
  }
}
