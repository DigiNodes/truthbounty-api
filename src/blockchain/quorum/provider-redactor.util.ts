import { redactSensitiveData } from '../../common/utils/redaction.util';

/**
 * Provider URL redaction — thin wrapper used everywhere a provider URL
 * crosses a log, error, or API boundary.
 *
 * Fails closed: if the URL cannot be parsed, we return a fixed string
 * rather than the raw input, so a malformed URL cannot leak a secret.
 */
export function redactProviderUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return '<empty-url>';
  }

  try {
    const parsed = new URL(rawUrl);

    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username) {
      parsed.username = '***';
    }

    // Mask any path segment that looks like an API key (long and random).
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) =>
        segment.length > 20
          ? `${segment.slice(0, 4)}...${segment.slice(-4)}`
          : segment,
      )
      .join('/');

    // Mask query params named like secrets.
    for (const [key] of Array.from(parsed.searchParams.entries())) {
      if (/key|secret|token|auth|api/i.test(key)) {
        parsed.searchParams.set(key, '***');
      }
    }

    // Final defense: run the whole result through the generic redactor.
    return redactSensitiveData(parsed.toString());
  } catch {
    return '<unparseable-url>';
  }
}
