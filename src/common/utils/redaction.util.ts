import * as crypto from 'crypto';

// Patterns to redact sensitive information
const SENSITIVE_PATTERNS = [
  // Credentials and Tokens
  /(password|passwd|pwd|secret|token|api_key|apikey|access_token|refresh_token|authorization)\s*[:=]\s*['"]?[^\s'"]+/gi,
  // Credit Cards
  /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
  // SSN
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // Private Keys (generic)
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
  // JWTs
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Hex strings that look like private keys or hashes (simple heuristic)
  /\b(?:0x)?[a-f0-9]{64}\b/gi,
];

export function redactSensitiveData(input: unknown): string {
  if (typeof input !== 'string') {
    return String(input);
  }

  let redacted = input;

  SENSITIVE_PATTERNS.forEach((pattern) => {
    redacted = redacted.replace(pattern, '[REDACTED]');
  });

  return redacted;
}

/**
 * Privacy redaction for text that may be persisted or used in caches/logs.
 * This is deliberately heuristic and must not be treated as proof that every
 * possible sensitive value was identified.
 */
export function redactPromptText(input: string): {
  text: string;
  redacted: boolean;
} {
  if (!input) return { text: input, redacted: false };

  let text = input;
  let redacted = false;
  const replace = (pattern: RegExp): void => {
    text = text.replace(pattern, (match) => {
      redacted = true;
      return '[REDACTED]';
    });
  };

  replace(/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]* )?PRIVATE KEY-----/gi);
  replace(/\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key)\s*[:=]\s*['"]?[^\s,'";]+/gi);
  replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
  replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g);
  replace(/\bS[A-Z2-7]{55}\b/g);
  replace(/\b(?:\d[ -]?){15,18}\d\b/g);
  replace(/\b\d{3}-\d{2}-\d{4}\b/g);
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi);
  replace(/(?:\+?\d{1,3}[ -]?)?(?:\(?\d{3}\)?[ -]?)\d{3}[ -]?\d{4}\b/g);
  replace(/(?:seed|mnemonic|recovery)[ -]?phrase\s*[:=]?\s+(?:[a-z]+\s+){11}[a-z]+\b/gi);

  return { text, redacted };
}

export function redactObject(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return redactSensitiveData(String(obj));
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item));
  }

  const redactedObj: any = {};
  for (const key of Object.keys(obj)) {
    // Redact common sensitive keys
    const sensitiveKeys = [
      'password',
      'secret',
      'token',
      'apiKey',
      'api_key',
      'authorization',
      'creditCard',
      'ssn',
      'privateKey',
      'access_token',
      'refresh_token',
    ];

    const normalizedKey = key.toLowerCase();
    if (sensitiveKeys.some((sensitive) => sensitive.toLowerCase() === normalizedKey)) {
      redactedObj[key] = '[REDACTED]';
    } else {
      redactedObj[key] = redactObject(obj[key]);
    }
  }

  return redactedObj;
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}
