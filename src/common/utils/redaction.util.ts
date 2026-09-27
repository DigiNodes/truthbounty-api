import * as crypto from 'crypto';

// Patterns to redact sensitive information
const SENSITIVE_PATTERNS = [
  // Credentials and Tokens
  /(?i)(password|passwd|pwd|secret|token|api_key|apikey|access_token|refresh_token|authorization)\s*[:=]\s*['"]?[^\s'"]+/g,
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

export function redactSensitiveData(input: string): string {
  if (typeof input !== 'string') {
    return String(input);
  }

  let redacted = input;

  SENSITIVE_PATTERNS.forEach((pattern) => {
    redacted = redacted.replace(pattern, '[REDACTED]');
  });

  return redacted;
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

    if (sensitiveKeys.includes(key.toLowerCase())) {
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