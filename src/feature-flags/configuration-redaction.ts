import { redactSensitiveData } from '../common/utils/redaction.util';
import { ConfigurationHistoryEntry } from './feature-flags.types';
import { ConfigurationValue } from './entities/configuration-value.entity';

const SENSITIVE_CONFIGURATION_KEY =
  /(?:password|passwd|secret|token|credential|api[-_]?key|private[-_]?key|webhook|signing[-_]?key|authorization|auth[-_]?token)/i;

const redactNestedValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return redactSensitiveData(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactNestedValue);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_CONFIGURATION_KEY.test(key)
          ? '[REDACTED]'
          : redactNestedValue(nestedValue),
      ]),
    );
  }

  return value;
};

export function redactConfigurationValue(
  key: string,
  value: unknown,
): unknown {
  return SENSITIVE_CONFIGURATION_KEY.test(key)
    ? '[REDACTED]'
    : redactNestedValue(value);
}

export function toConfigurationValueResponse(
  record: ConfigurationValue,
): ConfigurationValue {
  return {
    ...record,
    value: redactConfigurationValue(record.key, record.value),
  };
}

export function toConfigurationHistoryResponse(
  record: ConfigurationHistoryEntry,
): ConfigurationHistoryEntry {
  return {
    ...record,
    value: redactConfigurationValue(record.key, record.value),
  };
}
