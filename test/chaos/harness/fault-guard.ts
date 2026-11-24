import { URL } from 'url';

export interface GuardEnvironment {
  NODE_ENV?: string;
  APP_ENV?: string;
  STAGE?: string;
  TRUTHBOUNTY_CHAOS_ALLOWED?: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
  OPTIMISM_RPC_URL?: string;
  [key: string]: string | undefined;
}

export interface TargetValidationOptions {
  dependency: string;
  targetUrl?: string;
  environment?: GuardEnvironment;
  allowLocalhost?: boolean;
}

export class ProductionTargetError extends Error {
  constructor(message: string) {
    super(`[CHAOS GUARD BLOCKED] ${message}`);
    this.name = 'ProductionTargetError';
  }
}

/**
 * Patterns matching production or mainnet infrastructure.
 * Chaos injection MUST NEVER target these hosts or endpoints.
 */
const PRODUCTION_HOST_PATTERNS: RegExp[] = [
  /mainnet/i,
  /prod/i,
  /production/i,
  /truthbounty\.io/i,
  /truthbounty\.org/i,
  /api\.optimism\.io/i,
  /mainnet\.optimism\.io/i,
  /rpc\.ankr\.com\/optimism$/i,
  /alchemy\.com\/v2\/(?!.*sepolia).*/i,
  /infura\.io\/v3\/(?!.*sepolia).*/i,
];

/**
 * Safe testnet / non-production indicators.
 */
const ALLOWED_TESTNET_PATTERNS: RegExp[] = [
  /localhost/i,
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
  /test/i,
  /dev/i,
  /staging/i,
  /drill/i,
  /sepolia/i,
  /optimism-sepolia/i,
  /mock/i,
  /sandbox/i,
];

/**
 * Validates that an environment and target are safe for chaos fault injection.
 * Enforces fail-closed isolation.
 */
export function assertSafeChaosEnvironment(
  targetUrl?: string,
  env: GuardEnvironment = process.env,
): void {
  const nodeEnv = (env.NODE_ENV || '').toLowerCase();
  const appEnv = (env.APP_ENV || '').toLowerCase();
  const stage = (env.STAGE || '').toLowerCase();

  if (nodeEnv === 'production' || appEnv === 'production' || stage === 'prod' || stage === 'production') {
    throw new ProductionTargetError(
      `Chaos injection rejected: active environment is marked production (NODE_ENV=${nodeEnv}, APP_ENV=${appEnv}, STAGE=${stage})`,
    );
  }

  const chaosAllowed = (env.TRUTHBOUNTY_CHAOS_ALLOWED || '').toLowerCase();
  if (chaosAllowed !== 'true' && chaosAllowed !== '1') {
    throw new ProductionTargetError(
      'Chaos injection rejected: TRUTHBOUNTY_CHAOS_ALLOWED is not explicitly enabled (must be "true")',
    );
  }

  if (targetUrl) {
    assertSafeTargetUrl(targetUrl);
  }
}

/**
 * Validates that a target URL does not reference production infrastructure.
 */
export function assertSafeTargetUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    // If not a parseable URL, perform basic string checks
    for (const pattern of PRODUCTION_HOST_PATTERNS) {
      if (pattern.test(urlStr)) {
        throw new ProductionTargetError(
          `Target "${redactSensitiveUrl(urlStr)}" matches prohibited production pattern ${pattern}`,
        );
      }
    }
    return;
  }

  const hostname = parsed.hostname.toLowerCase();
  const fullPath = parsed.href.toLowerCase();

  // Explicit testnet/local bypass if it matches known test keywords and doesn't match strict production
  const hasAllowedPattern =
    parsed.protocol === 'mock:' ||
    ALLOWED_TESTNET_PATTERNS.some(
      (p) => p.test(hostname) || p.test(parsed.pathname) || p.test(parsed.protocol),
    );

  for (const pattern of PRODUCTION_HOST_PATTERNS) {
    if (pattern.test(hostname) || pattern.test(fullPath)) {
      // If it has "prod" or "mainnet" without being a verified sepolia/mock path, reject
      if (!hasAllowedPattern || /mainnet/i.test(hostname)) {
        throw new ProductionTargetError(
          `Target hostname "${hostname}" matches prohibited production pattern ${pattern}`,
        );
      }
    }
  }

  if (!hasAllowedPattern) {
    throw new ProductionTargetError(
      `Target "${hostname}" lacks an explicit safe environment indicator (localhost, dev, test, staging, sepolia, mock)`,
    );
  }
}

/**
 * Redacts secrets, tokens, passwords, and private keys from URLs and strings.
 */
export function redactSensitiveUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    if (parsed.password) {
      parsed.password = '[REDACTED]';
    }
    if (parsed.username && parsed.username !== 'default' && parsed.username !== 'postgres') {
      parsed.username = '[REDACTED]';
    }
    // Also redact secret query params (e.g., ?key=..., ?token=..., ?secret=...)
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/key|token|secret|password|auth|jwt/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return redactStringSecrets(urlStr);
  }
}

/**
 * Redacts common sensitive tokens, hex private keys, and credentials from string dumps.
 */
export function redactStringSecrets(input: string): string {
  return input
    // Hex private keys (0x followed by 64 hex characters)
    .replace(/0x[a-fA-F0-9]{64}/g, '0x[REDACTED_PRIVATE_KEY]')
    // Bearer tokens
    .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED_TOKEN]')
    // Key-value passwords / tokens / secrets
    .replace(/(password|secret|token|private_key|apiKey)\s*[:=]\s*["']?[^"'\s&]+["']?/gi, '$1=[REDACTED]');
}
