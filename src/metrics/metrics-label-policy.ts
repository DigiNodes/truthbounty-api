/**
 * Label and cardinality policy for Prometheus metrics.
 *
 * Prometheus keeps one time series per unique label-value combination, so a
 * label whose value comes from user input (wallet address, claim id, CID, URL,
 * free-text error, ...) lets any caller mint unbounded series and take down the
 * scraper. Every metric recorded through `MetricsService.incrementCounter` /
 * `setGauge` is passed through `sanitizeMetricLabels` before it reaches
 * prom-client, and the scrape endpoint is checked against a series budget.
 */

/** Label keys that must never appear: unbounded, user-supplied identifiers. */
export const UNBOUNDED_LABEL_KEYS = new Set([
  'wallet',
  'walletaddress',
  'wallet_address',
  'address',
  'account',
  'claim',
  'claimid',
  'claim_id',
  'cid',
  'ipfscid',
  'ipfs_cid',
  'url',
  'uri',
  'rpc_url',
  'error',
  'errormessage',
  'error_message',
  'error_text',
  'reason',
  'message',
  'hash',
  'txhash',
  'tx_hash',
  'transactionhash',
  'blockhash',
  'signature',
  'id',
  'aggregateid',
  'jobid',
  'notificationid',
  'requestid',
  'userid',
  'txid',
]);

/**
 * The only label keys a metric may carry. Everything else is dropped, so a
 * typo or a newly introduced identifier can't silently explode cardinality.
 * Values are still bounded by `isUnboundedLabelValue` and the value budget.
 */
export const BOUNDED_LABEL_KEYS = new Set([
  'method',
  'route',
  'status',
  'type',
  'mode',
  'queue',
  'state',
  'operation',
  'dependency',
  'required',
  'channel',
  'provider',
  'endpoint',
  'environment',
  'action',
  'severity',
  'category',
  'cachetype',
  'throttletype',
  'result',
  'event_type',
  'aggregate_type',
  'outcome',
  'chain',
  'release',
  'artifact',
]);

export const MAX_LABELS_PER_METRIC = 5;
export const MAX_LABEL_VALUE_LENGTH = 64;
/** Distinct values a single label may hold before the rest collapse to `other`. */
export const MAX_VALUES_PER_LABEL = 20;
export const OTHER_LABEL_VALUE = 'other';

/** Upper bound on the total number of series a scrape may expose. */
export const CARDINALITY_BUDGET = 600;

const UNBOUNDED_VALUE_PATTERNS: RegExp[] = [
  /^0x[a-fA-F0-9]{40}$/, // EVM wallet address
  /^0x[a-fA-F0-9]{64}$/, // tx / block hash
  /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{20,})$/, // IPFS CID v0/v1
  /^https?:\/\//i, // URL
  /\s/, // free text, e.g. a raw error message
  /^(sk-|AKIA|ghp_|eyJ|-----BEGIN)/, // provider/API/JWT/private-key shapes
];

/** True when a label value is an identifier/secret that must not become a series. */
export function isUnboundedLabelValue(value: string): boolean {
  if (value.length === 0) return false;
  if (value.length > MAX_LABEL_VALUE_LENGTH) return true;
  return UNBOUNDED_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Distinct values already admitted per `metric\u0000label`. */
const admittedValues = new Map<string, Set<string>>();

/** Test hook: forget admitted label values between cases. */
export function resetLabelValueBudget(): void {
  admittedValues.clear();
}

function boundValue(metric: string, key: string, value: string): string {
  if (isUnboundedLabelValue(value)) return OTHER_LABEL_VALUE;

  const id = `${metric}\u0000${key}`;
  let seen = admittedValues.get(id);
  if (!seen) {
    seen = new Set<string>();
    admittedValues.set(id, seen);
  }
  if (seen.has(value)) return value;
  if (seen.size >= MAX_VALUES_PER_LABEL) return OTHER_LABEL_VALUE;
  seen.add(value);
  return value;
}

/** Keep a label value only while it stays bounded; otherwise collapse it. */
export function boundLabelValue(value: string | number): string {
  const text = String(value);
  return isUnboundedLabelValue(text) ? OTHER_LABEL_VALUE : text;
}

/**
 * Drop disallowed label keys and collapse unbounded/over-budget values.
 * Returns plain string labels, ready to hand to prom-client.
 */
export function sanitizeMetricLabels(
  metric: string,
  labels: Record<string, string | number>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (Object.keys(safe).length >= MAX_LABELS_PER_METRIC) break;
    const normalized = key.toLowerCase();
    if (UNBOUNDED_LABEL_KEYS.has(normalized)) continue;
    if (!BOUNDED_LABEL_KEYS.has(normalized)) continue;
    safe[key] = boundValue(metric, normalized, String(value));
  }
  return safe;
}

/** Count exported series (samples), ignoring HELP/TYPE comment lines. */
export function countSeries(registryText: string): number {
  const samples = registryText
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return samples.length;
}

/** Throws when a scrape exceeds the cardinality budget — this is the CI gate. */
export function assertCardinalityBudget(
  registryText: string,
  budget = CARDINALITY_BUDGET,
): void {
  const series = countSeries(registryText);
  if (series > budget) {
    throw new Error(
      `metrics cardinality budget exceeded: ${series} series > ${budget}`,
    );
  }
}
