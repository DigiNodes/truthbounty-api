/**
 * Versioned, minimal allowlists for optional analytics events.
 * Anything not listed is dropped. Forbidden keys are never allowed.
 */

export const FORBIDDEN_ANALYTICS_KEYS = [
  'wallet',
  'walletAddress',
  'address',
  'signature',
  'sig',
  'evidence',
  'evidenceCid',
  'evidenceHash',
  'privateKey',
  'mnemonic',
  'token',
  'password',
  'authorization',
  'cookie',
] as const;

/** eventName → schemaVersion → allowed property keys */
export const ANALYTICS_SCHEMAS: Record<string, Record<number, readonly string[]>> = {
  app_opened: {
    1: ['surface', 'locale'],
  },
  claim_list_viewed: {
    1: ['resultCount', 'sort'],
  },
  settings_changed: {
    1: ['settingKey'],
  },
};

export const CURRENT_CONSENT_POLICY_VERSION = '2026-10-16';

export function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_ANALYTICS_KEYS.some(
    (f) => lower === f.toLowerCase() || lower.includes('signature') || lower.includes('evidence'),
  );
}
