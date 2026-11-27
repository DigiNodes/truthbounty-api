import { promises as dns, type LookupAddress } from 'dns';
import { isIP } from 'net';

/**
 * Webhook SSRF guard.
 *
 * Centralizes the public-destination policy for outbound webhook delivery so
 * that every code path that sends an HTTP request to a user-configured URL
 * (the notification-channel webhook, the outbound webhook service, and the
 * preference save endpoint) applies the same checks.
 *
 * The guard is split into composable pieces:
 *  - {@link parseWebhookUrl}      synchronous structural validation (scheme,
 *                                credentials, port allowlist, blocked names).
 *  - {@link isUnsafeIp}           IP-range classification for IPv4 and IPv6.
 *  - {@link resolveHostname}      DNS resolution (overridable for tests).
 *  - {@link validateWebhookDestination}  full async validation: structure +
 *                                DNS resolution + per-address classification.
 *  - {@link createValidatingDnsLookup}  a Node `lookup` function that validates
 *                                the *exact* addresses the socket will connect
 *                                to, closing the DNS-rebinding TOCTOU window.
 *
 * It is intentionally free of NestJS decorators so it can be unit-tested and
 * reused without dependency-injection wiring.
 */

/** Options shared by every validation entry point. */
export interface WebhookUrlOptions {
  /** When true, only `https:` URLs are accepted. */
  readonly requireHttps: boolean;
  /** Explicit TCP port allowlist. Defaults to {@link DEFAULT_WEBHOOK_PORTS}. */
  readonly allowedPorts?: readonly number[];
  /**
   * When true, skip the port-allowlist check (any valid TCP port is accepted).
   * Used by consumers that must preserve a pre-existing permissive port
   * policy; new webhook paths should leave this false and use the allowlist.
   */
  readonly allowAnyPort?: boolean;
  /**
   * Optional resolver override. Tests use this to simulate DNS rebinding and
   * private resolutions without touching the real network.
   */
  readonly resolve?: (hostname: string) => Promise<string[]>;
}

/** Result of the synchronous structural check. */
export interface WebhookUrlStructure {
  readonly valid: boolean;
  readonly error?: string;
  readonly parsed?: URL;
  readonly hostname?: string;
  readonly port?: number;
}

/** Result of the full async destination validation. */
export interface WebhookDestinationValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly hostname?: string;
  readonly resolvedAddresses?: readonly string[];
}

/**
 * Default port allowlist for outbound webhooks. Kept narrow on purpose: only
 * the standard HTTP(S) ports plus the two most common alternate HTTPS ports.
 */
export const DEFAULT_WEBHOOK_PORTS = Object.freeze([80, 443, 8080, 8443]);

/**
 * Hostnames that are always rejected by name, before any DNS lookup. These
 * either resolve to link-local cloud-metadata addresses or are reserved for
 * the local host. Blocking them by name is defense-in-depth; the authoritative
 * protection is the per-address check performed after resolution.
 */
const BLOCKED_HOSTNAMES = new Set<string>([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata.azure.com',
]);

/** Suffixes that denote local or reserved naming and are never routable. */
const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.localhost', '.internal'];

/**
 * Validate the structure of a webhook URL without touching the network.
 *
 * Rejects:
 *  - non-http(s) schemes (and non-https when {@link WebhookUrlOptions.requireHttps});
 *  - embedded credentials (`user:pass@host`);
 *  - empty / bracket-only hostnames and malformed hosts;
 *  - blocked local/reserved names and suffixes;
 *  - ports outside the explicit allowlist.
 *
 * IPv6 literal hosts in URLs arrive wrapped in brackets (`[::1]`); the brackets
 * are stripped so downstream IP classification receives the bare address.
 */
export function parseWebhookUrl(
  rawUrl: string,
  options: WebhookUrlOptions,
): WebhookUrlStructure {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: 'Webhook URL is not a valid absolute URL' };
  }

  if (options.requireHttps && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Webhook URL must use https' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Webhook URL must use http or https' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Webhook URL must not contain credentials' };
  }

  // Strip surrounding brackets from IPv6 literals so `isIP` can classify them.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { valid: false, error: 'Webhook URL must include a hostname' };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: 'Webhook URL must not target local hosts' };
  }

  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { valid: false, error: 'Webhook URL must not target local hosts' };
  }

  const allowedPorts = options.allowedPorts ?? DEFAULT_WEBHOOK_PORTS;
  const explicitPort = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === 'https:'
      ? 443
      : 80;

  if (
    !Number.isFinite(explicitPort) ||
    explicitPort <= 0 ||
    explicitPort > 65535
  ) {
    return { valid: false, error: 'Webhook URL has an invalid port' };
  }

  if (!options.allowAnyPort && !allowedPorts.includes(explicitPort)) {
    return {
      valid: false,
      error: `Webhook URL port must be one of: ${allowedPorts.join(', ')}`,
    };
  }

  return { valid: true, parsed, hostname, port: explicitPort };
}

/**
 * Classify a single IP literal as safe (public) or unsafe (private / reserved /
 * loopback / link-local / multicast / cloud-metadata / non-routable).
 *
 * Returns `true` when the address MUST NOT be contacted. Non-IP strings (the
 * `family === 0` case) also return `true` so callers fail closed.
 */
export function isUnsafeIp(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;

    if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
    if (a === 10) return true; // 10.0.0.0/8 private (RFC1918)
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private (RFC1918)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private (RFC1918)
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1 (documentation)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2 (documentation)
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3 (documentation)
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved

    return false;
  }

  if (family === 6) {
    const normalized = address.toLowerCase();

    if (normalized === '::1' || normalized === '::') {
      return true; // loopback / unspecified
    }

    // ff00::/8 multicast
    if (normalized.startsWith('ff')) return true;

    // fe80::/10 link-local (fe80:: - febf::)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }

    // fec0::/10 site-local, deprecated (fec0:: - feff::)
    if (
      normalized.startsWith('fec') ||
      normalized.startsWith('fed') ||
      normalized.startsWith('fee') ||
      normalized.startsWith('fef')
    ) {
      return true;
    }

    // fc00::/7 unique local addresses (fc00:: - fdff::)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

    // IPv4-mapped (::ffff:0:0/96) — classify the embedded IPv4.
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      if (isIP(mapped) === 4) {
        return isUnsafeIp(mapped);
      }
      return true; // malformed mapping — fail closed
    }

    return false;
  }

  // Not a valid IP literal — fail closed.
  return true;
}

/**
 * Resolve a hostname to its IP addresses using the supplied resolver, or the
 * OS resolver via `dns.lookup({ all: true })` when none is provided.
 */
export async function resolveHostname(
  hostname: string,
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  const resolver = resolve ?? defaultResolve;
  return resolver(hostname);
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/**
 * Fully validate a webhook destination: structural check, then (for hostnames)
 * DNS resolution with per-address classification. Literal IP URLs skip DNS and
 * are classified directly.
 *
 * This is the entry point used at both save time and delivery time. Because
 * DNS records can change, callers MUST revalidate at delivery time and SHOULD
 * pair this with {@link createValidatingDnsLookup} so the connection itself is
 * pinned to validated addresses.
 */
export async function validateWebhookDestination(
  rawUrl: string,
  options: WebhookUrlOptions,
): Promise<WebhookDestinationValidationResult> {
  const structure = parseWebhookUrl(rawUrl, options);
  if (!structure.valid || !structure.parsed || !structure.hostname) {
    return { valid: false, error: structure.error };
  }

  const hostname = structure.hostname;

  // Literal IP — no DNS, classify directly.
  if (isIP(hostname)) {
    if (isUnsafeIp(hostname)) {
      return {
        valid: false,
        error: 'Webhook URL must not target a private or internal address',
      };
    }
    return { valid: true, hostname, resolvedAddresses: [hostname] };
  }

  let addresses: string[];
  try {
    addresses = await resolveHostname(hostname, options.resolve);
  } catch {
    return {
      valid: false,
      error: 'Webhook URL hostname could not be resolved',
    };
  }

  if (addresses.length === 0) {
    return {
      valid: false,
      error: 'Webhook URL hostname did not resolve to any address',
    };
  }

  for (const address of addresses) {
    if (isUnsafeIp(address)) {
      return {
        valid: false,
        error: 'Webhook URL must not resolve to a private or internal address',
      };
    }
  }

  return { valid: true, hostname, resolvedAddresses: addresses };
}

/**
 * Lookup callback signature compatible with Node's `net.Socket`/`http.Agent`
 * `lookup` option (handles both the single-address and `all` variants).
 */
type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  result: string | LookupAddress[] | null,
  family?: number,
) => void;

/**
 * Create a Node-compatible DNS `lookup` function that validates the *exact*
 * addresses the socket will connect to.
 *
 * Installing this on an `http.Agent`/`https.Agent` means the addresses used for
 * the TCP/TLS connection are validated at the moment of connection — there is
 * no gap between validation and dialing, which is what defeats DNS rebinding:
 * even if a hostname returns a public address to an earlier check and a
 * private address at connection time, this lookup rejects it before the socket
 * opens.
 *
 * Literal-IP hostnames are classified directly (no DNS).
 */
export function createValidatingDnsLookup(
  resolve?: (hostname: string) => Promise<string[]>,
): (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: DnsLookupCallback,
) => void {
  const resolver = resolve ?? defaultResolve;

  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: DnsLookupCallback,
  ): void => {
    // Literal IP — validate directly without DNS.
    if (isIP(hostname)) {
      if (isUnsafeIp(hostname)) {
        return callback(
          makeBlockedError(`${hostname} is a private or internal address`),
          null,
        );
      }
      if (options?.all) {
        return callback(null, [{ address: hostname, family: isIP(hostname) }]);
      }
      return callback(null, hostname, isIP(hostname));
    }

    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          return callback(
            makeBlockedError(`${hostname} did not resolve`),
            null,
          );
        }

        for (const address of addresses) {
          if (isUnsafeIp(address)) {
            return callback(
              makeBlockedError(
                `${hostname} resolves to a private or internal address`,
              ),
              null,
            );
          }
        }

        if (options?.all) {
          const mapped: LookupAddress[] = addresses.map((address) => ({
            address,
            family: isIP(address),
          }));
          return callback(null, mapped);
        }

        const first = addresses[0];
        return callback(null, first, isIP(first));
      },
      (err) => callback(err as NodeJS.ErrnoException, null),
    );
  };
}

function makeBlockedError(message: string): NodeJS.ErrnoException {
  const err = new Error(
    `Blocked destination: ${message}`,
  ) as NodeJS.ErrnoException;
  err.code = 'ESSRF';
  return err;
}
