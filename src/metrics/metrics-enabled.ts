import { getRuntimeEnvironment } from '../config/runtime-config';
export function isMetricsExplicitlyDisabled(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'false';
}

export function isNotificationMetricsEnabled(
  raw: string | undefined = getRuntimeEnvironment().METRICS_ENABLED,
): boolean {
  return !isMetricsExplicitlyDisabled(raw);
}
