import * as net from 'net';
import {
  FORBIDDEN_IPV4_CIDRS,
  FORBIDDEN_IPV6_CIDRS,
  CLOUD_METADATA_IPS,
} from './ssrf.constants';

export interface IpValidationResult {
  isForbidden: boolean;
  reason?: string;
  normalizedIp?: string;
}

/**
 * Converts a 32-bit unsigned integer to a dotted-decimal IPv4 string.
 */
export function intToIpv4(intVal: number): string {
  const p1 = (intVal >>> 24) & 255;
  const p2 = (intVal >>> 16) & 255;
  const p3 = (intVal >>> 8) & 255;
  const p4 = intVal & 255;
  return `${p1}.${p2}.${p3}.${p4}`;
}

/**
 * Parses a single part of an IPv4 address (decimal, octal with 0 prefix, or hex with 0x prefix).
 * Returns null if invalid.
 */
function parseIpv4Part(part: string): number | null {
  const trimmed = part.trim();
  if (trimmed.length === 0) return null;

  let num: number;
  if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
    num = parseInt(trimmed, 16);
  } else if (/^0[0-7]+$/.test(trimmed)) {
    num = parseInt(trimmed, 8);
  } else if (/^\d+$/.test(trimmed)) {
    num = parseInt(trimmed, 10);
  } else {
    return null;
  }

  if (isNaN(num) || num < 0 || num > 0xffffffff) {
    return null;
  }
  return num;
}

/**
 * Attempts to parse any representation of an IPv4 address, including:
 * - Dotted-quad: "127.0.0.1", "0177.0.0.1", "0x7f.0.0.1"
 * - Dotted-triplet, doublet: "127.0.1", "127.1"
 * - Single integer (dword): "2130706433", "0x7f000001", "017700000001"
 * Returns normalized dotted-decimal string or null if not an IPv4 address.
 */
export function parseAndNormalizeIpv4(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Check if it's a single integer representation (decimal, hex, octal)
  if (/^(?:0x[0-9a-fA-F]+|0[0-7]+|\d+)$/i.test(trimmed)) {
    let intVal: number;
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
      intVal = parseInt(trimmed, 16);
    } else if (/^0[0-7]+$/.test(trimmed)) {
      intVal = parseInt(trimmed, 8);
    } else {
      intVal = parseInt(trimmed, 10);
    }

    if (isNaN(intVal) || intVal < 0 || intVal > 0xffffffff) {
      return null;
    }
    return intToIpv4(intVal);
  }

  // Dotted notation (1 to 4 parts)
  const parts = trimmed.split('.');
  if (parts.length > 4 || parts.length < 1) return null;

  const parsedParts: number[] = [];
  for (const part of parts) {
    const val = parseIpv4Part(part);
    if (val === null) return null;
    parsedParts.push(val);
  }

  // Follow standard inet_aton semantics for classful/partial IP strings
  let finalInt = 0;
  if (parsedParts.length === 4) {
    for (let i = 0; i < 4; i++) {
      if (parsedParts[i] > 255) return null;
    }
    finalInt =
      ((parsedParts[0] << 24) |
        (parsedParts[1] << 16) |
        (parsedParts[2] << 8) |
        parsedParts[3]) >>>
      0;
  } else if (parsedParts.length === 3) {
    if (parsedParts[0] > 255 || parsedParts[1] > 255 || parsedParts[2] > 0xffff)
      return null;
    finalInt =
      ((parsedParts[0] << 24) | (parsedParts[1] << 16) | parsedParts[2]) >>> 0;
  } else if (parsedParts.length === 2) {
    if (parsedParts[0] > 255 || parsedParts[1] > 0xffffff) return null;
    finalInt = ((parsedParts[0] << 24) | parsedParts[1]) >>> 0;
  } else if (parsedParts.length === 1) {
    finalInt = parsedParts[0] >>> 0;
  }

  return intToIpv4(finalInt);
}

/**
 * Checks if an IPv4 string falls within a given IPv4 CIDR range.
 */
export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(rangeIp);
  if (ipInt === null || rangeInt === null) return false;

  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/**
 * Parses and expands an IPv6 address into a 128-bit BigInt.
 * Also handles IPv4-mapped IPv6 (::ffff:192.0.2.1) and IPv4-compatible (::192.0.2.1).
 */
export function ipv6ToBigInt(
  ip: string,
): { bigInt: bigint; mappedIpv4?: string } | null {
  let cleaned = ip.trim().toLowerCase();
  // Strip bracket notation if present
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1);
  }

  // Check for IPv4 mapped or compatible at end: e.g. ::ffff:192.168.1.1
  const lastColon = cleaned.lastIndexOf(':');
  let mappedIpv4: string | undefined;
  if (lastColon !== -1) {
    const possibleIpv4 = cleaned.slice(lastColon + 1);
    if (possibleIpv4.includes('.')) {
      const parsedV4 = parseAndNormalizeIpv4(possibleIpv4);
      if (parsedV4 !== null) {
        mappedIpv4 = parsedV4;
        const v4Parts = parsedV4.split('.').map((p) => parseInt(p, 10));
        const hex1 = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
        const hex2 = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
        cleaned = `${cleaned.slice(0, lastColon)}:${hex1}:${hex2}`;
      }
    }
  }

  if (!net.isIPv6(cleaned)) {
    return null;
  }

  const parts = cleaned.split('::');
  if (parts.length > 2) return null;

  let leftParts: string[] = [];
  let rightParts: string[] = [];

  if (parts.length === 2) {
    leftParts = parts[0] ? parts[0].split(':') : [];
    rightParts = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (leftParts.length + rightParts.length);
    if (missing < 0) return null;
    const middle: string[] = new Array<string>(missing).fill('0');
    parts[0] = [...leftParts, ...middle, ...rightParts].join(':');
  }

  const fullSegments = parts[0].split(':');
  if (fullSegments.length !== 8) return null;

  let result = 0n;
  for (const seg of fullSegments) {
    const val = parseInt(seg || '0', 16);
    if (isNaN(val) || val < 0 || val > 0xffff) return null;
    result = (result << 16n) | BigInt(val);
  }

  return { bigInt: result, mappedIpv4 };
}

/**
 * Checks if an IPv6 address falls within a given IPv6 CIDR range.
 */
export function isIpv6InCidr(ipBigInt: bigint, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;

  const rangeParsed = ipv6ToBigInt(rangeIp);
  if (!rangeParsed) return false;

  if (prefix === 0) return true;
  const shift = 128n - BigInt(prefix);
  return ipBigInt >> shift === rangeParsed.bigInt >> shift;
}

/**
 * Validates any IP address (IPv4 or IPv6, including all encoded formats)
 * against forbidden network ranges and metadata IPs.
 */
export function validateIpAddress(ipInput: string): IpValidationResult {
  const trimmed = ipInput.trim();

  // Try IPv4 first (including encoded)
  const normalizedIpv4 = parseAndNormalizeIpv4(trimmed);
  if (normalizedIpv4 !== null) {
    // Check cloud metadata explicit IPs
    if (CLOUD_METADATA_IPS.includes(normalizedIpv4)) {
      return {
        isForbidden: true,
        reason: `Target IP ${normalizedIpv4} matches cloud metadata service`,
        normalizedIp: normalizedIpv4,
      };
    }

    // Check forbidden IPv4 CIDRs
    for (const cidr of FORBIDDEN_IPV4_CIDRS) {
      if (isIpv4InCidr(normalizedIpv4, cidr)) {
        return {
          isForbidden: true,
          reason: `Target IP ${normalizedIpv4} falls within forbidden range ${cidr}`,
          normalizedIp: normalizedIpv4,
        };
      }
    }

    return {
      isForbidden: false,
      normalizedIp: normalizedIpv4,
    };
  }

  // Try IPv6
  const parsedIpv6 = ipv6ToBigInt(trimmed);
  if (parsedIpv6 !== null) {
    // If it's an IPv4-mapped or IPv4-compatible address, check the mapped IPv4 too!
    if (parsedIpv6.mappedIpv4) {
      const v4Result = validateIpAddress(parsedIpv6.mappedIpv4);
      if (v4Result.isForbidden) {
        return {
          isForbidden: true,
          reason: `IPv4-mapped target ${parsedIpv6.mappedIpv4} is forbidden: ${v4Result.reason}`,
          normalizedIp: trimmed,
        };
      }
    }

    // Check forbidden IPv6 CIDRs
    for (const cidr of FORBIDDEN_IPV6_CIDRS) {
      if (isIpv6InCidr(parsedIpv6.bigInt, cidr)) {
        return {
          isForbidden: true,
          reason: `Target IPv6 address falls within forbidden range ${cidr}`,
          normalizedIp: trimmed,
        };
      }
    }

    return {
      isForbidden: false,
      normalizedIp: trimmed,
    };
  }

  // Neither valid IPv4 nor IPv6
  return {
    isForbidden: true,
    reason: `Invalid or unrecognized IP address format: ${ipInput}`,
  };
}
