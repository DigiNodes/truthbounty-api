/**
 * Utility to mask/anonymize IP addresses for GDPR compliance.
 * - IPv4: replaces the last octet with '0' (e.g., 203.0.113.45 -> 203.0.113.0)
 * - IPv6: replaces the interface identifier (last 64 bits/4 groups) with '0' (e.g., 2001:db8:85a3:8d3:1319:8a2e:370:7334 -> 2001:db8:85a3:8d3::)
 * - IPv4-mapped IPv6: masks the IPv4 part (e.g., ::ffff:203.0.113.45 -> ::ffff:203.0.113.0)
 */

export function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;

  const trimmed = ip.trim();
  const colonCount = (trimmed.match(/:/g) || []).length;

  // Handle IPv4 (potentially with a port)
  if (trimmed.includes('.')) {
    if (colonCount === 1) {
      // IPv4 with port (e.g., 192.168.1.1:8080)
      const lastColon = trimmed.lastIndexOf(':');
      const ipv4Part = trimmed.substring(0, lastColon);
      const portPart = trimmed.substring(lastColon);
      return `${maskIpv4(ipv4Part)}${portPart}`;
    } else if (colonCount > 1) {
      // IPv4-mapped IPv6 (e.g., ::ffff:192.168.1.1)
      const lastColon = trimmed.lastIndexOf(':');
      const ipv4Part = trimmed.substring(lastColon + 1);
      const prefix = trimmed.substring(0, lastColon + 1);
      return `${prefix}${maskIpv4(ipv4Part)}`;
    } else {
      // Standard IPv4 (e.g., 192.168.1.1)
      return maskIpv4(trimmed);
    }
  }

  // Handle standard IPv6
  if (colonCount > 0) {
    return maskIpv6(trimmed);
  }

  // If we can't determine the type, return as is (fallback)
  return trimmed;
}

function maskIpv4(ip: string): string {
  const parts = ip.split('.');
  if (parts.length >= 4) {
    // Zero out the last octet
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  return ip;
}

function maskIpv6(ip: string): string {
  try {
    let cleanIp = ip.toLowerCase();

    // Handle brackets (e.g., [2001:db8::1]:80)
    if (cleanIp.startsWith('[') && cleanIp.includes(']')) {
      cleanIp = cleanIp.substring(1, cleanIp.indexOf(']'));
    }

    // Handle zone index (e.g., fe80::1%eth0)
    const percentIndex = cleanIp.indexOf('%');
    if (percentIndex !== -1) {
      cleanIp = cleanIp.substring(0, percentIndex);
    }

    // Special case for loopback/empty shorthand
    if (cleanIp === '::') {
      return '::';
    }

    const doubleColonIndex = cleanIp.indexOf('::');
    let expandedParts: string[];

    if (doubleColonIndex !== -1) {
      const leftSide = cleanIp.substring(0, doubleColonIndex);
      const rightSide = cleanIp.substring(doubleColonIndex + 2);

      const leftParts: string[] = leftSide ? leftSide.split(':') : [];
      const rightParts: string[] = rightSide ? rightSide.split(':') : [];

      const missingCount = 8 - (leftParts.length + rightParts.length);
      const middleParts: string[] = Array(missingCount).fill('0') as string[];

      expandedParts = [...leftParts, ...middleParts, ...rightParts];
    } else {
      expandedParts = cleanIp.split(':');
    }

    // Zero out the last 4 segments (making it /64 prefix)
    for (let i = 4; i < 8; i++) {
      expandedParts[i] = '0';
    }

    const firstFour = expandedParts.slice(0, 4);

    // Check if the prefix is all zeros (like for ::1 loopback)
    const isAllZeros = firstFour.every((part) => part === '0' || part === '');
    if (isAllZeros) {
      return '::';
    }

    return `${firstFour.join(':')}::`;
  } catch {
    // If anything fails in parsing, return original
    return ip;
  }
}
