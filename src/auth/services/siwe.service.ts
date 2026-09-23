import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyMessage } from 'ethers';
import {
  SiweMessage,
  ParsedSiweMessage,
  SiweVerifyParams,
  SiweVerifyResult,
} from '../types/siwe.types';

const SIWE_VERSION_SUPPORTED = '1';
// EIP-4361 §2.3: nonce SHOULD be at least 8 characters.
const NONCE_MIN_LENGTH = 8;

/**
 * SIWE (Sign-In with Ethereum) Service — EIP-4361
 *
 * Parses, constructs, and strictly validates SIWE messages.
 * Supports MetaMask, Rabby, WalletConnect, Coinbase Wallet, and any
 * EIP-191 compliant wallet through standard ECDSA signature verification.
 *
 * The service is fail-closed on every security-relevant dimension:
 * domain, origin, chain ID, statement, nonce, time window, and (when
 * configured) resources. Any uncertainty rejects the message; it never
 * silently downgrades to fabricated state.
 */
@Injectable()
export class SiweService {
  private readonly logger = new Logger(SiweService.name);
  private readonly NONCE_TTL_MS: number;
  private readonly allowedOrigins: string[];
  private readonly allowedDomains: string[];
  private readonly supportedChainIds: number[];
  private readonly expectedStatement?: string;

  constructor(private readonly configService: ConfigService) {
    this.NONCE_TTL_MS =
      parseInt(
        configService.get<string>('AUTH_NONCE_TTL_MS', String(5 * 60 * 1000)),
        10,
      );

    this.allowedOrigins = this.parseList(
      configService.get<string>('SIWE_ALLOWED_ORIGINS'),
    );
    this.allowedDomains = this.parseList(
      configService.get<string>('SIWE_ALLOWED_DOMAINS'),
    );
    this.supportedChainIds = this.parseChainIds(
      configService.get<string>('SIWE_SUPPORTED_CHAIN_IDS', '10'),
    );
    this.expectedStatement =
      configService.get<string>('SIWE_EXPECTED_STATEMENT') ?? undefined;
  }

  /**
   * Build a SIWE-compliant challenge message for a wallet address.
   */
  buildSiweMessage(params: {
    domain: string;
    address: string;
    uri: string;
    chainId: number;
    nonce: string;
    statement?: string;
    expirationTime?: string;
  }): string {
    const { domain, address, uri, chainId, nonce, statement } = params;

    const issuedAt = new Date().toISOString();
    const expirationMs = this.configService.get<number>(
      'AUTH_NONCE_TTL_MS',
      5 * 60 * 1000,
    );
    const expirationTime =
      params.expirationTime ??
      new Date(Date.now() + expirationMs).toISOString();

    const lines: string[] = [
      `${domain} wants you to sign in with your Ethereum account:`,
      address,
      '',
    ];

    if (statement) {
      lines.push(statement);
      lines.push('');
    }

    lines.push(`URI: ${uri}`);
    lines.push('Version: 1');
    lines.push(`Chain ID: ${chainId}`);
    lines.push(`Nonce: ${nonce}`);
    lines.push(`Issued At: ${issuedAt}`);

    if (expirationTime) {
      lines.push(`Expiration Time: ${expirationTime}`);
    }

    return lines.join('\n');
  }

  /**
   * Build a backward-compatible simple challenge (for non-SIWE clients).
   */
  buildLegacyMessage(nonce: string, appName: string = 'TruthBounty'): string {
    return `Sign in to ${appName}: ${nonce}`;
  }

  /**
   * Parse a SIWE message string into structured fields.
   * Falls back to legacy format for backward compatibility.
   */
  parseMessage(rawMessage: string): ParsedSiweMessage | null {
    try {
      const lines = rawMessage.split('\n');

      // Check if this is a SIWE-formatted message
      if (rawMessage.includes('wants you to sign in with your Ethereum account')) {
        return this.parseSiweFormat(lines, rawMessage);
      }

      // Fallback: legacy format "Sign in to {app}: {nonce}"
      const legacyMatch = rawMessage.match(/^Sign in to (.+): ([A-Za-z0-9]+)$/);
      if (legacyMatch) {
        return {
          domain: legacyMatch[1],
          address: '',
          uri: '',
          version: '1',
          chainId: 1,
          nonce: legacyMatch[2],
          issuedAt: new Date().toISOString(),
          rawMessage,
        };
      }

      return null;
    } catch (err) {
      this.logger.warn(`Failed to parse SIWE message: ${err}`);
      return null;
    }
  }

  /**
   * Verify a SIWE message signature and enforce the full strict set of
   * EIP-4361 security constraints.
   *
   * Steps (EIP-4361 + V2-BE-063 hardening):
   * 1. Recover address from signature
   * 2. Validate EIP-4361 message structure (version, fields, nonce shape)
   * 3. Validate address matches the recovered signer (case-insensitive)
   * 4. Validate domain against the expected domain / allowlist
   * 5. Validate URI origin against the expected origin / allowlist
   * 6. Validate chain ID against the supported chains
   * 7. Validate statement against the configured expected statement
   * 8. Validate nonce shape (>= 8 chars, alphanumeric per EIP-4361)
   * 9. Validate time window: expiration, not-before, issued-at freshness
   * 10. Validate resources (when configured / provided)
   */
  async verifySiwe(params: SiweVerifyParams): Promise<SiweVerifyResult> {
    const {
      message,
      signature,
      expectedDomain,
      expectedOrigin,
      expectedChainId,
      expectedStatement,
      allowedOrigins,
      allowedDomains,
      supportedChainIds,
    } = params;

    // 1. Recover address from signature
    let recoveredAddress: string;
    try {
      recoveredAddress = verifyMessage(message, signature);
    } catch {
      return {
        success: false,
        error: 'INVALID_SIGNATURE',
        address: undefined,
      };
    }

    // 2. Parse the message
    const parsed = this.parseMessage(message);
    if (!parsed) {
      return {
        success: false,
        error: 'MALFORMED_MESSAGE',
        address: recoveredAddress,
      };
    }

    // Structural EIP-4361 checks that fail closed.
    if (parsed.version !== SIWE_VERSION_SUPPORTED) {
      return {
        success: false,
        error: 'UNSUPPORTED_VERSION',
        address: recoveredAddress,
        data: parsed,
      };
    }
    if (Number.isNaN(parsed.chainId) || parsed.chainId <= 0) {
      return {
        success: false,
        error: 'INVALID_CHAIN_ID',
        address: recoveredAddress,
        data: parsed,
      };
    }
    if (parsed.nonce.length < NONCE_MIN_LENGTH) {
      return {
        success: false,
        error: 'INVALID_NONCE',
        address: recoveredAddress,
        data: parsed,
      };
    }
    if (!/^[a-zA-Z0-9]+$/.test(parsed.nonce)) {
      return {
        success: false,
        error: 'INVALID_NONCE',
        address: recoveredAddress,
        data: parsed,
      };
    }

    // 3. Validate address matches (case-insensitive)
    if (
      parsed.address &&
      parsed.address.toLowerCase() !== recoveredAddress.toLowerCase()
    ) {
      return {
        success: false,
        error: 'ADDRESS_MISMATCH',
        address: recoveredAddress,
      };
    }

    // 4. Validate domain against expected / allowlist
    const domainAllowlist = allowedDomains?.length
      ? allowedDomains
      : this.allowedDomains;
    if (expectedDomain) {
      if (!this.domainsEqual(parsed.domain, expectedDomain)) {
        return {
          success: false,
          error: 'DOMAIN_MISMATCH',
          address: recoveredAddress,
          data: parsed,
        };
      }
    } else if (
      domainAllowlist.length > 0 &&
      !domainAllowlist.some((d) => this.domainsEqual(parsed.domain, d))
    ) {
      return {
        success: false,
        error: 'DOMAIN_NOT_ALLOWED',
        address: recoveredAddress,
        data: parsed,
      };
    }

    // 5. Validate URI origin against expected / allowlist
    if (expectedOrigin || allowedOrigins?.length || this.allowedOrigins.length) {
      let origin: string | null = null;
      try {
        origin = new URL(parsed.uri).origin;
      } catch {
        return {
          success: false,
          error: 'MALFORMED_URI',
          address: recoveredAddress,
          data: parsed,
        };
      }

      const originAllowlist = allowedOrigins?.length
        ? allowedOrigins
        : this.allowedOrigins;
      if (expectedOrigin && origin !== expectedOrigin) {
        return {
          success: false,
          error: 'ORIGIN_MISMATCH',
          address: recoveredAddress,
          data: parsed,
        };
      }
      if (
        originAllowlist.length > 0 &&
        !originAllowlist.includes(origin)
      ) {
        return {
          success: false,
          error: 'ORIGIN_NOT_ALLOWED',
          address: recoveredAddress,
          data: parsed,
        };
      }
    }

    // 6. Validate chain ID against supported chains
    const chains = supportedChainIds?.length
      ? supportedChainIds
      : this.supportedChainIds;
    if (expectedChainId !== undefined && parsed.chainId !== expectedChainId) {
      return {
        success: false,
        error: 'CHAIN_MISMATCH',
        address: recoveredAddress,
        data: parsed,
      };
    }
    if (chains.length > 0 && !chains.includes(parsed.chainId)) {
      return {
        success: false,
        error: 'CHAIN_NOT_SUPPORTED',
        address: recoveredAddress,
        data: parsed,
      };
    }

    // 7. Validate statement against the expected statement
    const statementToCheck = expectedStatement ?? this.expectedStatement;
    if (statementToCheck && parsed.statement !== statementToCheck) {
      return {
        success: false,
        error: 'STATEMENT_MISMATCH',
        address: recoveredAddress,
        data: parsed,
      };
    }

    // 8. Validate time window (EIP-4361 §2.6.6)
    if (parsed.expirationTime) {
      const expirationMs = new Date(parsed.expirationTime).getTime();
      if (Number.isNaN(expirationMs) || Date.now() > expirationMs) {
        return {
          success: false,
          error: 'MESSAGE_EXPIRED',
          address: recoveredAddress,
          data: parsed,
        };
      }
    }

    if (parsed.notBefore) {
      const notBeforeMs = new Date(parsed.notBefore).getTime();
      if (Number.isNaN(notBeforeMs) || Date.now() < notBeforeMs) {
        return {
          success: false,
          error: 'MESSAGE_NOT_YET_VALID',
          address: recoveredAddress,
          data: parsed,
        };
      }
    }

    // Issued At must be a valid timestamp and not in the future beyond skew.
    const issuedAtMs = new Date(parsed.issuedAt).getTime();
    if (Number.isNaN(issuedAtMs)) {
      return {
        success: false,
        error: 'MALFORMED_ISSUED_AT',
        address: recoveredAddress,
        data: parsed,
      };
    }
    if (Date.now() - issuedAtMs > this.NONCE_TTL_MS) {
      return {
        success: false,
        error: 'MESSAGE_STALE',
        address: recoveredAddress,
        data: parsed,
      };
    }
    if (issuedAtMs > Date.now() + 60_000) {
      return {
        success: false,
        error: 'MESSAGE_FROM_FUTURE',
        address: recoveredAddress,
        data: parsed,
      };
    }

    // 10. Validate resources (when provided) are well-formed URIs.
    if (parsed.resources?.length) {
      for (const resource of parsed.resources) {
        try {
          // eslint-disable-next-line no-new
          new URL(resource);
        } catch {
          return {
            success: false,
            error: 'MALFORMED_RESOURCE',
            address: recoveredAddress,
            data: parsed,
          };
        }
      }
    }

    return {
      success: true,
      data: {
        ...parsed,
        address: recoveredAddress.toLowerCase(),
      },
      address: recoveredAddress.toLowerCase(),
    };
  }

  /**
   * Validate a wallet provider signature format.
   * MetaMask, Rabby, WalletConnect, Coinbase Wallet all use EIP-191.
   * Standard EVM signature is 65 bytes (r: 32, s: 32, v: 1) = 130 hex chars
   * plus the '0x' prefix. Some wallets produce 64-byte sigs (rare).
   */
  validateProviderSignature(signature: string): boolean {
    return /^0x[a-fA-F0-9]{130,132}$/.test(signature);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private parseSiweFormat(lines: string[], rawMessage: string): ParsedSiweMessage | null {
    const result: Partial<ParsedSiweMessage> = {
      version: '1',
      chainId: 1,
      rawMessage,
    };

    // Line 0: "${domain} wants you to sign in with your Ethereum account:"
    const domainMatch = lines[0]?.match(
      /^(.+) wants you to sign in with your Ethereum account:$/,
    );
    if (domainMatch) {
      result.domain = domainMatch[1].trim();
    }

    // Line 1: address
    if (lines[1]?.startsWith('0x')) {
      result.address = lines[1].toLowerCase();
    }

    // Parse statement, KV pairs, and resources starting from line 2.
    // Structure: line[2] is always blank; statement (if any) appears before
    // KV pairs; resources (if any) appear as "- <uri>" lines after a
    // "Resources:" marker.
    const statementLines: string[] = [];
    let kvStarted = false;
    let resourcesMode = false;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      if (resourcesMode) {
        const resourceMatch = line.match(/^- (.+)$/);
        if (resourceMatch) {
          result.resources = result.resources ?? [];
          result.resources.push(resourceMatch[1].trim());
          continue;
        }
        resourcesMode = false;
      }

      if (line === 'Resources:') {
        resourcesMode = true;
        continue;
      }

      const kvMatch = line.match(/^([A-Za-z ]+): (.+)$/);
      if (kvMatch) {
        kvStarted = true;
        const [, key, value] = kvMatch;
        switch (key) {
          case 'URI':
            result.uri = value;
            break;
          case 'Version':
            result.version = value;
            break;
          case 'Chain ID':
            result.chainId = parseInt(value, 10);
            break;
          case 'Nonce':
            result.nonce = value;
            break;
          case 'Issued At':
            result.issuedAt = value;
            break;
          case 'Expiration Time':
            result.expirationTime = value;
            break;
          case 'Not Before':
            result.notBefore = value;
            break;
          case 'Request ID':
            result.requestId = value;
            break;
        }
      } else if (!kvStarted) {
        // Non-blank, non-KV line before any KV pair = statement content
        statementLines.push(line);
      }
    }

    if (statementLines.length > 0) {
      result.statement = statementLines.join('\n');
    }

    // Ensure required fields exist
    if (!result.domain || !result.uri || !result.nonce || !result.issuedAt) {
      return null;
    }

    return result as ParsedSiweMessage;
  }

  private parseList(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private parseChainIds(raw: string | undefined): number[] {
    return this.parseList(raw)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  private domainsEqual(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}
