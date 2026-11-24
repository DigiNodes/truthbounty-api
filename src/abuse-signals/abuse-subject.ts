import { createHmac } from 'node:crypto';
import { maskIp } from '../audit/utils/ip-masking';
import {
  AbuseAttributionFailure,
  AbuseSubjectKind,
  AbuseSubjectResolution,
} from './abuse-signals.types';

/**
 * Trusted subject resolution (PREWAVE-BE-086, #681).
 *
 * Everything downstream keys off the value produced here, so the rules are
 * deliberately conservative:
 *
 *  1. Only verified sources identify a subject: a validated JWT principal, a
 *     wallet address carried **inside** that JWT, or the socket's own address.
 *  2. Attacker-controlled headers never identify anyone. `x-wallet-address`,
 *     `x-wallet`, `x-api-key` and a client-supplied `x-forwarded-for` are
 *     ignored outright, so forging them cannot move traffic onto — or off —
 *     somebody else's budget. (The existing wallet rate limiter *does* trust
 *     `x-wallet-address`; that is its concern, and this module must not
 *     inherit the weakness.)
 *  3. Anonymous traffic is bucketed to a **masked** network prefix (/24 or
 *     /64), never a single address, so a shared NAT, campus or corporate
 *     egress collapses into one coarse subject instead of punishing an
 *     unlucky bystander.
 *  4. The stored key is a salted HMAC, never the raw identifier, so signals
 *     and audit records cannot be reversed into personal data.
 *  5. No salt, or a malformed identifier, yields an *unattributed* result.
 *     Resolution never guesses, and an unattributed observation produces an
 *     indeterminate decision rather than an action.
 */

/** Request-shaped input. Only verified fields are read. */
export interface AbuseIdentityInput {
  /** Verified principal from the JWT strategy, not from a header. */
  principalId?: string | null;
  /**
   * Wallet address taken from a **validated JWT claim**. Anonymous callers
   * leave this null; a raw header value never reaches here.
   */
  walletAddress?: string | null;
  /** `req.socket.remoteAddress` (or `req.ip` once proxy trust is resolved). */
  socketRemoteAddress?: string | null;
  /** Raw `x-forwarded-for`; only the configured number of hops is honoured. */
  forwardedFor?: string | string[] | null;
  /** Proxy hops the deployment actually trusts (0 = socket address only). */
  trustedProxyHops: number;
  /** HMAC salt; null disables attribution entirely. */
  subjectSalt: string | null;
}

const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** Strict dotted quad: four octets, each 0-255, no leading zeroes. */
const IPV4_PATTERN = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

/** True for a syntactically valid, in-range dotted quad. */
export function isIpv4(value: string): boolean {
  if (!IPV4_PATTERN.test(value)) return false;
  return value
    .split('.')
    .every((octet) => Number(octet) <= 255);
}

/**
 * Strips an IPv4-mapped IPv6 prefix.
 *
 * `::ffff:198.51.100.7` and `198.51.100.7` are the same egress. Keeping both
 * forms would give one client two independent budgets just by alternating
 * which address family its proxy reports, so the mapping is removed before the
 * subject key is derived.
 */
export function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return mapped ? mapped[1] : address;
}

/**
 * Normalizes a socket/proxy address into a bare IP literal.
 *
 * Strips an IPv4 port, IPv6 brackets, an IPv6 zone index, and an IPv4-mapped
 * IPv6 prefix. Returns null for anything that is not a valid IP, rather than
 * passing it through.
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (value === '') return null;

  // [::1]:443 -> ::1
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    value = value.slice(1, close);
  } else if (value.includes(':')) {
    const colons = (value.match(/:/g) ?? []).length;
    // A single colon with dotted-quad digits on the left is an IPv4 port.
    if (colons === 1) {
      const lastColon = value.lastIndexOf(':');
      const left = value.slice(0, lastColon);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(left)) value = left;
    }
  }

  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  value = unmapIpv4(value);

  const ipv4 = isIpv4(value);
  const isIpv6 = value.includes(':') && /^[0-9a-f:.]+$/.test(value);
  if (!ipv4 && !isIpv6) return null;
  return value;
}

/**
 * Resolves the client address from the socket plus the trusted proxy chain.
 *
 * `X-Forwarded-For` is attacker-appendable, so the **right-most** entries are
 * the ones written by infrastructure we control. Taking `hops + 1` entries from
 * the right and discarding the rest means an extra client-supplied prefix can
 * never move the derived address.
 */
export function resolveTrustedAddress(
  socketRemoteAddress: string | null | undefined,
  forwardedFor: string | string[] | null | undefined,
  trustedProxyHops: number,
): string | null {
  const socket = normalizeAddress(socketRemoteAddress);
  if (trustedProxyHops <= 0 || !forwardedFor) return socket;

  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
    .split(',')
    .map((part) => normalizeAddress(part))
    .filter((part): part is string => part !== null);

  // chain is client -> proxy order; the last `trustedProxyHops` entries were
  // appended by hops we trust, so the one immediately before them is the
  // originating client.
  const index = chain.length - trustedProxyHops;
  if (index < 0) return socket;
  return chain[index];
}

/** Derives the stable, non-reversible subject key. */
function deriveKey(salt: string, kind: string, value: string): string {
  return createHmac('sha256', salt).update(`${kind}:${value}`).digest('hex');
}

/**
 * Headers a caller controls and that must never identify a subject.
 *
 * Listed explicitly so the boundary is auditable: adding a header here is a
 * deliberate act, and `x-wallet-address` in particular is trusted by the
 * existing wallet rate limiter, so it is called out as *not* trusted here.
 */
export const ATTACKER_CONTROLLED_IDENTITY_HEADERS = Object.freeze([
  'x-wallet-address',
  'x-wallet',
  'x-api-key',
  'x-auth-request-wallet',
  'x-forwarded-wallet',
]);

/** Express-shaped request; only the fields read here are used. */
export interface AbuseRequestLike {
  user?: {
    sub?: unknown;
    userId?: unknown;
    address?: unknown;
    walletAddress?: unknown;
  } | null;
  method?: unknown;
  originalUrl?: unknown;
  ip?: unknown;
  socket?: { remoteAddress?: unknown } | null;
  headers?: Record<string, unknown>;
  get?(name: string): string | undefined;
}

/** Case-insensitive single-header read over the Express request. */
function header(req: AbuseRequestLike, name: string): string | undefined {
  const fromGetter = typeof req.get === 'function' ? req.get(name) : undefined;
  if (typeof fromGetter === 'string' && fromGetter !== '') return fromGetter;
  const headers = req.headers ?? {};
  const match = Object.keys(headers).find(
    (key) => key.toLowerCase() === name,
  );
  const value = match ? headers[match] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Extracts the trusted identity input from a request.
 *
 * Note what is *not* read: `x-wallet-address` and friends. Only the wallet
 * claim inside a validated JWT is used, and only `x-forwarded-for` — bounded to
 * the deployment's trusted hop count — influences the network subject.
 */
export function identityInputFromRequest(
  req: AbuseRequestLike,
  policy: { trustedProxyHops: number; subjectSalt: string | null },
): AbuseIdentityInput {
  const user = req.user ?? undefined;
  return {
    principalId: stringOrNull(user?.sub) ?? stringOrNull(user?.userId),
    walletAddress:
      stringOrNull(user?.address) ?? stringOrNull(user?.walletAddress),
    socketRemoteAddress:
      stringOrNull(req.socket?.remoteAddress) ?? stringOrNull(req.ip),
    forwardedFor: header(req, 'x-forwarded-for') ?? null,
    trustedProxyHops: policy.trustedProxyHops,
    subjectSalt: policy.subjectSalt,
  };
}

/**
 * Resolves a request to an abuse subject.
 *
 * Pure and synchronous so it can be exercised directly; the returned key is
 * deterministic for a given (salt, kind, value) triple.
 */
export function resolveAbuseSubject(
  input: AbuseIdentityInput,
): AbuseSubjectResolution {
  const sawUntrustedHeader = Boolean(
    input.principalId || input.walletAddress || input.socketRemoteAddress,
  );

  if (!input.subjectSalt || input.subjectSalt.length < 32) {
    return {
      attributed: false,
      reason: AbuseAttributionFailure.CONFIGURATION_UNAVAILABLE,
    };
  }

  // 1. Verified principal.
  const principal = input.principalId?.trim();
  if (principal) {
    return {
      attributed: true,
      subject: {
        kind: AbuseSubjectKind.PRINCIPAL,
        key: deriveKey(input.subjectSalt, 'principal', principal),
      },
    };
  }

  // 2. Wallet from a validated claim. A malformed claim is refused outright
  //    rather than silently downgraded to a network subject.
  const wallet = input.walletAddress?.trim();
  if (wallet) {
    if (!WALLET_PATTERN.test(wallet)) {
      return {
        attributed: false,
        reason: AbuseAttributionFailure.MALFORMED_IDENTIFIER,
      };
    }
    return {
      attributed: true,
      subject: {
        kind: AbuseSubjectKind.WALLET,
        key: deriveKey(input.subjectSalt, 'wallet', wallet.toLowerCase()),
      },
    };
  }

  // 3. Anonymous: a masked network prefix, never a full address.
  const address = resolveTrustedAddress(
    input.socketRemoteAddress,
    input.forwardedFor,
    input.trustedProxyHops,
  );
  if (address) {
    const masked = maskIp(address);
    if (masked) {
      return {
        attributed: true,
        subject: {
          kind: AbuseSubjectKind.NETWORK_PREFIX,
          key: deriveKey(input.subjectSalt, 'netprefix', masked),
        },
      };
    }
  }

  // Nothing verifiable was present. If the only thing that existed was a
  // value the caller supplied on its own behalf, say so explicitly so
  // operators can distinguish "anonymous" from "forged".
  return {
    attributed: false,
    reason: sawUntrustedHeader
      ? AbuseAttributionFailure.UNTRUSTED_IDENTIFIER_ONLY
      : AbuseAttributionFailure.UNIDENTIFIED,
  };
}