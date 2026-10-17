import * as dns from 'dns';
import {
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_ALLOWED_PROTOCOLS,
  FORBIDDEN_HOSTNAMES,
} from './ssrf.constants';
import {
  parseAndNormalizeIpv4,
  ipv6ToBigInt,
  validateIpAddress,
} from './ip-parser.util';

export class SsrfSecurityException extends Error {
  constructor(
    message: string,
    public readonly code: string = 'SSRF_BLOCKED',
  ) {
    super(`SSRF Protection Violation: ${message}`);
    this.name = 'SsrfSecurityException';
    Object.setPrototypeOf(this, SsrfSecurityException.prototype);
  }
}

export interface SsrfValidatorOptions {
  allowedProtocols?: readonly string[];
  allowedPorts?: readonly number[];
  allowedHostnames?: readonly string[];
  allowPrivateIps?: boolean;
  customDnsLookup?: (
    hostname: string,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => void;
}

export interface ValidatedUrlResult {
  url: URL;
  hostname: string;
  port: number;
  protocol: string;
  isDirectIp: boolean;
  normalizedIp?: string;
}

/**
 * Validates a target URL string against SSRF security policies:
 * - Scheme allowlisting
 * - Userinfo / credential rejection
 * - Port allowlisting
 * - Hostname allowlisting / blocklisting
 * - Encoded IP detection and rejection of forbidden IP ranges
 */
export function validateTargetUrl(
  inputUrl: string,
  options?: SsrfValidatorOptions,
): ValidatedUrlResult {
  if (!inputUrl || typeof inputUrl !== 'string') {
    throw new SsrfSecurityException('URL input must be a non-empty string');
  }

  const trimmed = inputUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new SsrfSecurityException(`Malformed or invalid URL: ${errorMsg}`);
  }

  // 1. Protocol validation
  const allowedProtocols =
    options?.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  if (!allowedProtocols.includes(parsed.protocol.toLowerCase())) {
    throw new SsrfSecurityException(
      `Protocol '${parsed.protocol}' is forbidden. Allowed: ${allowedProtocols.join(', ')}`,
      'FORBIDDEN_PROTOCOL',
    );
  }

  // 2. Credential-bearing target rejection (userinfo)
  if (parsed.username || parsed.password) {
    throw new SsrfSecurityException(
      'Credential-bearing targets (username/password in URL) are forbidden',
      'CREDENTIALS_IN_URL',
    );
  }

  // 3. Port validation
  const defaultPort = parsed.protocol.toLowerCase() === 'https:' ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const allowedPorts = options?.allowedPorts ?? DEFAULT_ALLOWED_PORTS;

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new SsrfSecurityException(`Invalid port number: ${parsed.port}`);
  }

  if (!allowedPorts.includes(port)) {
    throw new SsrfSecurityException(
      `Port ${port} is forbidden. Allowed ports: ${allowedPorts.join(', ')}`,
      'FORBIDDEN_PORT',
    );
  }

  // 4. Hostname validation
  let rawHost = parsed.hostname;
  if (!rawHost) {
    throw new SsrfSecurityException('Empty hostname is forbidden');
  }

  // Strip brackets from IPv6 host
  if (rawHost.startsWith('[') && rawHost.endsWith(']')) {
    rawHost = rawHost.slice(1, -1);
  }

  const lowerHost = rawHost.toLowerCase();

  // Check forbidden hostname blocklist
  if (FORBIDDEN_HOSTNAMES.includes(lowerHost)) {
    throw new SsrfSecurityException(
      `Hostname '${rawHost}' is explicitly forbidden`,
      'FORBIDDEN_HOSTNAME',
    );
  }

  // Check if host is direct or encoded IP address
  const directIpv4 = parseAndNormalizeIpv4(rawHost);
  const directIpv6 = ipv6ToBigInt(rawHost);

  if (directIpv4 !== null || directIpv6 !== null) {
    const ipToCheck = directIpv4 ?? rawHost;
    const ipValidation = validateIpAddress(ipToCheck);
    if (ipValidation.isForbidden) {
      const isMetadata = ipValidation.reason?.includes('cloud metadata');
      if (isMetadata || !options?.allowPrivateIps) {
        throw new SsrfSecurityException(
          `Direct IP address '${rawHost}' is forbidden: ${ipValidation.reason}`,
          'FORBIDDEN_IP',
        );
      }
    }

    return {
      url: parsed,
      hostname: parsed.hostname,
      port,
      protocol: parsed.protocol.toLowerCase(),
      isDirectIp: true,
      normalizedIp: ipValidation.normalizedIp ?? ipToCheck,
    };
  }

  return {
    url: parsed,
    hostname: parsed.hostname,
    port,
    protocol: parsed.protocol.toLowerCase(),
    isDirectIp: false,
  };
}

/**
 * Resolves a hostname via DNS and validates every returned address.
 * Fails closed if any resolved IP belongs to a forbidden range.
 */
export async function resolveAndValidateDns(
  hostname: string,
  options?: {
    allowPrivateIps?: boolean;
    dnsResolver?: (
      host: string,
      opts: dns.LookupAllOptions,
    ) => Promise<dns.LookupAddress[]>;
  },
): Promise<dns.LookupAddress[]> {
  // If hostname is already an IP, validate directly
  const directIpv4 = parseAndNormalizeIpv4(hostname);
  const directIpv6 = ipv6ToBigInt(hostname);

  if (directIpv4 !== null || directIpv6 !== null) {
    const ip = directIpv4 ?? hostname;
    const result = validateIpAddress(ip);
    if (result.isForbidden && !options?.allowPrivateIps) {
      throw new SsrfSecurityException(
        `Resolved IP '${ip}' is forbidden: ${result.reason}`,
        'FORBIDDEN_RESOLVED_IP',
      );
    }
    return [{ address: ip, family: directIpv4 ? 4 : 6 }];
  }

  let addresses: dns.LookupAddress[] = [];
  try {
    if (options?.dnsResolver) {
      addresses = await options.dnsResolver(hostname, { all: true });
    } else {
      addresses = await dns.promises.lookup(hostname, { all: true });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new SsrfSecurityException(
      `DNS lookup failed for hostname '${hostname}': ${errorMsg}`,
      'DNS_RESOLUTION_FAILED',
    );
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfSecurityException(
      `No DNS records resolved for hostname '${hostname}'`,
      'DNS_NO_RECORDS',
    );
  }

  // Validate every resolved IP
  for (const record of addresses) {
    const ip = record.address;
    const validation = validateIpAddress(ip);
    if (validation.isForbidden) {
      const isMetadata = validation.reason?.includes('cloud metadata');
      if (isMetadata || !options?.allowPrivateIps) {
        throw new SsrfSecurityException(
          `Hostname '${hostname}' resolved to forbidden address '${ip}': ${validation.reason}`,
          'FORBIDDEN_RESOLVED_IP',
        );
      }
    }
  }

  return addresses;
}
