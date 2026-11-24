import { Injectable } from '@nestjs/common';

/**
 * Centralized redaction boundary.
 *
 * Every production log must pass through this service. It removes credentials,
 * signatures, wallet addresses, evidence, support data, URLs, and provider errors
 * from arbitrarily nested values. Secret canaries must never appear in the
 * output.
 */

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Keys that are always redacted regardless of their value.
 */
const SENSITIVE_KEYS: RegExp[] = [
  /password/i,
  /passphrase/i,
  /secret/i,
  /token/i,
  /api[-key]/i,
  /apiKey/i,
  /authorization/i,
  /credential/i,
  /private[key]?/i,
  /seed/i,
  /mnemonic/i,
  /signature/i,
  /signed/i,
  /sign/i,
  /session/i,
  /cookie/i,
  /jwt/i,
  /bearer/i,
  /wallet/i,
  /address/i,
  /evidence/i,
  /support/i,
  /supportData/i,
  /support_data/i,
  /url/i,
  /endpoint/i,
  /providerError/i,
  /provider_error/i,
  /rawResponse/i,
  /raw_response/i,
];

/**
 * Value patterns that indicate a secret regardless of the key name.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // JWT-like three-segment tokens.
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[aA-Za-z0-9_-]+$/,
  // Bearer tokens.
  /^Bearer\s/i,
  // Hex encoded signatures (64+ bytes).
  /^[0-9a-f]{128,}$/i,
  // Stellar secret seeds (S...) and public keys (G...).
  /^S[A-Z0-9]{55}$/,
  /^G[A-Z0-9]{55}$/,
];

const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

@Injectable()
export class RedactionService {
  /**
   * Redact a value recursively. Circular references are replaced with a
   * placeholder, depth and array size are bounded, and strings are truncated.
   */
  redact<T>(value: T, key?: string): unknown {
    return this.redactValue(value, key, { depth: 0, seen: new WeakSet<object>() });
  }

  /**
   * Redact a whole record of fields. Returns a new object with sensitive
   * keys replaced by the redaction placeholder.
   */
  redactRecord(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = this.redactValue(value, key, {
        depth: 0,
        seen: new WeakSet<object>(),
      });
    }
    return out;
  }

  /**
   * Returns true when a key name is considered sensitive.
   */
  isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.some((pattern) => pattern.test(key));
  }

  /**
   * Returns true when a value looks like a secret canary.
   */
  isSecretValue(value: unknown): boolean {
    if (typeof value !== 'string') {
      return false;
    }
    return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }

  private redactValue(
    value: unknown,
    key: string | undefined,
    state: { depth: number; seen: WeakSet<object> },
  ): unknown {
    if (key !== undefined && this.isSensitiveKey(key)) {
      return REDACTED_PLACEHOLDER;
    }
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      return this.redactString(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return this.redactError(value);
    }
    if (state.depth > MAX_DEPTH) {
      return '[max-depth]';
    }
    if (typeof value === 'object') {
      if (state.seen.has(value as object)) {
        return '[circular]';
      }
      state.seen.add(value as object);
      if (Array.isArray(value)) {
        const limited = value.slice(0, MAX_ARRAY).map((item) =>
          this.redactValue(item, key, {
            depth: state.depth + 1,
            seen: state.seen,
          }),
        );
        if (value.length > MAX_ARRAY) {
          limited.push(`[+truncated ${value.length - MAX_ARRAY} items]`);
        }
        return limited;
      }
      const out: Record<string, unknown> = {};
      for (const [innerKey, innerValue] of Object.entries(value)) {
        out[innerKey] = this.redactValue(innerValue, innerKey, {
          depth: state.depth + 1,
          seen: state.seen,
        });
      }
      return out;
    }
    return String(value);
  }

  private redactString(value: string): string {
    if (this.isSecretValue(value)) {
      return REDACTED_PLACEHOLDER;
    }
    // Remove control characters that could forge log records.
    const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (stripped.length > MAX_STRING_LENGTH) {
      return `${stripped.slice(0, MAX_STRING_LENGTH)}[kruncated]`;
    }
    return stripped;
  }

  private redactError(error: Error): Record<string, unknown> {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: this.redactString(error.message),
      code: code !== undefined ? this.redactString(String(code)) : undefined,
      stack: error.stack ? this.redactString(error.stack) : undefined,
    };
  }
}
