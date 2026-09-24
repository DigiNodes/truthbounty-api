import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyMessage } from 'ethers';
import {
  SiweMessage,
  ParsedSiweMessage,
  SiweVerifyParams,
  SiweVerifyResult,
} from '../types/siwe.types';

/**
 * SIWE (Sign-In with Ethereum) Service — EIP-4361
 *
 * Parses, constructs, and validates SIWE messages.
 * Supports MetaMask, Rabby, WalletConnect, Coinbase Wallet, and any
 * EIP-191 compliant wallet through standard ECDSA signature verification.
 */
@Injectable()
export class SiweService {
  private readonly logger = new Logger(SiweService.name);
  private readonly NONCE_TTL_MS: number;

  constructor(private readonly configService: ConfigService) {
    this.NONCE_TTL_MS =
      parseInt(
        configService.get<string>('AUTH_NONCE_TTL_MS', String(5 * 60 * 1000)),
        10,
      );
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
   * Verify a SIWE message signature.
   *
   * Steps (EIP-4361):
   * 1. Recover address from signature
   * 2. Validate address matches
   * 3. Validate domain matches expected domain
   * 4. Validate nonce has not expired
   * 5. Validate chain ID (if specified)
   */
  async verifySiwe(params: SiweVerifyParams): Promise<SiweVerifyResult> {
    const { message, signature, expectedDomain, expectedOrigin } = params;

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

    // 4. Validate domain if expected
    if (expectedDomain && parsed.domain !== expectedDomain) {
      return {
        success: false,
        error: 'DOMAIN_MISMATCH',
        address: recoveredAddress,
        data: parsed,
      };
    }

    // 5. Validate origin/URI if expected
    if (expectedOrigin && parsed.uri) {
      try {
        const parsedOrigin = new URL(parsed.uri).origin;
        if (parsedOrigin !== expectedOrigin) {
          return {
            success: false,
            error: 'ORIGIN_MISMATCH',
            address: recoveredAddress,
            data: parsed,
          };
        }
      } catch {
        // URI may not be a full URL — skip origin check
      }
    }

    // 6. Validate expiration
    if (parsed.expirationTime) {
      const expirationMs = new Date(parsed.expirationTime).getTime();
      if (Date.now() > expirationMs) {
        return {
          success: false,
          error: 'MESSAGE_EXPIRED',
          address: recoveredAddress,
          data: parsed,
        };
      }
    }

    // 7. Validate not-before
    if (parsed.notBefore) {
      const notBeforeMs = new Date(parsed.notBefore).getTime();
      if (Date.now() < notBeforeMs) {
        return {
          success: false,
          error: 'MESSAGE_NOT_YET_VALID',
          address: recoveredAddress,
          data: parsed,
        };
      }
    }

    // 8. Validate issuedAt is not too far in the past (stale message)
    const issuedAtMs = new Date(parsed.issuedAt).getTime();
    if (Date.now() - issuedAtMs > this.NONCE_TTL_MS) {
      return {
        success: false,
        error: 'MESSAGE_STALE',
        address: recoveredAddress,
        data: parsed,
      };
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
   * This is a passthrough for now — all standard EVM wallets use the same sign method.
   */
  validateProviderSignature(signature: string): boolean {
    // Standard EVM signature is 65 bytes (r: 32, s: 32, v: 1) = 130 hex chars
    // With '0x' prefix = 132 chars. Some wallets may produce 64-byte sigs (rare).
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

    // Parse statement and KV pairs starting from line 2
    // Structure: line[2] is always blank; statement (if any) appears before KV pairs
    const statementLines: string[] = [];
    let kvStarted = false;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') continue;

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
    if (!result.domain || !result.address || !result.nonce || !result.issuedAt) {
      return null;
    }

    return result as ParsedSiweMessage;
  }
}
