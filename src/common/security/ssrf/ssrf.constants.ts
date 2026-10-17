/**
 * SSRF Security Constants and Default Configuration
 */

export const FORBIDDEN_IPV4_CIDRS: readonly string[] = [
  '0.0.0.0/8', // "This network" RFC 1122
  '10.0.0.0/8', // Private-use RFC 1918
  '100.64.0.0/10', // Shared address space / CGNAT RFC 6598
  '127.0.0.0/8', // Loopback RFC 1122
  '169.254.0.0/16', // Link-local RFC 3927 / Cloud metadata
  '172.16.0.0/12', // Private-use RFC 1918
  '192.0.0.0/24', // IETF Protocol Assignments RFC 6890
  '192.0.2.0/24', // TEST-NET-1 RFC 5737
  '192.88.99.0/24', // 6to4 Relay Anycast RFC 7526
  '192.168.0.0/16', // Private-use RFC 1918
  '198.18.0.0/15', // Network benchmark RFC 2544
  '198.51.100.0/24', // TEST-NET-2 RFC 5737
  '203.0.113.0/24', // TEST-NET-3 RFC 5737
  '224.0.0.0/4', // Multicast RFC 5771
  '240.0.0.0/4', // Reserved for future use RFC 1112
  '255.255.255.255/32', // Limited Broadcast RFC 919
];

export const FORBIDDEN_IPV6_CIDRS: readonly string[] = [
  '::/128', // Unspecified address RFC 4291
  '::1/128', // Loopback address RFC 4291
  '::ffff:0:0/96', // IPv4-mapped IPv6 (also evaluated as IPv4)
  '64:ff9b::/96', // IPv4/IPv6 translation RFC 6052
  '100::/64', // Discard-only prefix RFC 6666
  '2001::/23', // IETF Protocol Assignments RFC 2928
  '2001:db8::/32', // Documentation RFC 3849
  'fc00::/7', // Unique Local Address (ULA) RFC 4193
  'fe80::/10', // Link-local unicast RFC 4291
  'ff00::/8', // Multicast RFC 4291
];

export const FORBIDDEN_HOSTNAMES: readonly string[] = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
];

export const CLOUD_METADATA_IPS: readonly string[] = [
  '169.254.169.254', // AWS, Azure, GCP, DigitalOcean, OpenStack
  '169.254.169.253', // AWS DNS
  '169.254.169.123', // AWS NTP
  '169.254.0.1', // Oracle Cloud
  '100.100.100.200', // Alibaba Cloud
];

export const DEFAULT_ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

export const DEFAULT_ALLOWED_METHODS: readonly string[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
];

export const SENSITIVE_HEADERS_TO_STRIP: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
];

export const SSRF_DEFAULTS = {
  CONNECT_TIMEOUT_MS: 5000,
  REQUEST_TIMEOUT_MS: 10000,
  MAX_REDIRECTS: 5,
  MAX_RESPONSE_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
};
