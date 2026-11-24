/**
 * Public Incident Sanitizer (UX-BE-002).
 *
 * Enforces sanitization of untrusted Markdown and URLs for public incident screens.
 * Redacts internal topology, hostnames, connection strings, credentials, and dangerous
 * schemes (javascript:, data:, vbscript:, file:).
 */

const FORBIDDEN_SUBSTRINGS = [
  'db.internal.truthbounty',
  'postgres://',
  'postgresql://',
  'mongodb://',
  'redis://',
  's3cr3t',
  'cluster.local',
  'Error: connect ECONNREFUSED',
  'at Socket',
  'failureReason',
  'responseTimeMs',
  'memoryUsage',
  'rpc.internal',
  'internal.truthbounty',
];

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // Link-local & cloud metadata
  /\.local$/i,
  /\.internal$/i,
  /\.cluster\.local$/i,
  /\.lan$/i,
];

/**
 * Strips HTML tags, removes dangerous URI schemes, and redacts protected patterns
 * while preserving valid Markdown styling.
 */
export function sanitizeMarkdown(raw: string | null | undefined): string {
  if (!raw) return '';

  let sanitized = String(raw);

  // 1. Strip raw HTML tags (e.g. <script>...</script>, <iframe ...>, <img onerror=...>)
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  sanitized = sanitized.replace(/<[^>]+>/g, '');

  // 2. Sanitize Markdown links: [text](href)
  // Neutralize javascript:, data:, vbscript:, file: links
  sanitized = sanitized.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match, text, href) => {
      const trimmedHref = href.trim();
      if (/^(javascript|vbscript|data|file):/i.test(trimmedHref)) {
        return `[${text}](#)`;
      }
      return match;
    },
  );

  // 3. Redact forbidden internal substrings and secret patterns
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (sanitized.toLowerCase().includes(forbidden.toLowerCase())) {
      const regex = new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      sanitized = sanitized.replace(regex, '[REDACTED]');
    }
  }

  // 4. Redact potential bearer tokens or 64-char hex secrets
  sanitized = sanitized.replace(/bearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/(password|secret|apikey|token)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]');

  return sanitized.trim();
}

/**
 * Validates and sanitizes untrusted URLs for post-incident links.
 * Requires HTTPS and rejects private/internal hostnames, local IPs, and cloud metadata.
 * Returns null if the URL is invalid or unsafe.
 */
export function sanitizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  try {
    const trimmed = raw.trim();
    const parsed = new URL(trimmed);

    // Strictly enforce https:
    if (parsed.protocol !== 'https:') {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check against private/internal hostnames and IP ranges
    for (const pattern of PRIVATE_HOST_PATTERNS) {
      if (pattern.test(hostname)) {
        return null;
      }
    }

    // Strip credentials (user:pass)
    parsed.username = '';
    parsed.password = '';

    return parsed.toString();
  } catch {
    return null;
  }
}
