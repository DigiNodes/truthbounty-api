export function isMetricsExplicitlyDisabled(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'false';
}

export function isNotificationMetricsEnabled(
  raw: string | undefined = process.env.METRICS_ENABLED,
): boolean {
  return !isMetricsExplicitlyDisabled(raw);
}
