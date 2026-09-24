type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | Date
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumericKey(key: string): boolean {
  return String(Number(key)) === key;
}

/**
 * Recursively converts native BigInt values into decimal strings so blockchain
 * amounts remain exact across JSON persistence and API responses.
 */
export function serializeBigInts<T>(value: T): JsonSafeValue {
  return serializeBigIntsInternal(value, new WeakSet<object>());
}

function serializeBigIntsInternal(
  value: unknown,
  seen: WeakSet<object>,
): JsonSafeValue {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (!isObject(value)) {
    return null;
  }

  if (seen.has(value)) {
    throw new TypeError(
      'Cannot serialize circular structure with BigInt values',
    );
  }

  seen.add(value);

  const maybeResult = value as { toObject?: () => Record<string, unknown> };
  if (typeof maybeResult.toObject === 'function') {
    try {
      const serializedResult = serializeBigIntsInternal(
        maybeResult.toObject(),
        seen,
      );
      seen.delete(value);
      return serializedResult;
    } catch {
      // Fall back to enumerable keys for array-like decoded results.
    }
  }

  if (Array.isArray(value)) {
    const serializedArray = value.map((item) =>
      serializeBigIntsInternal(item, seen),
    ) as JsonSafeValue[];
    seen.delete(value);
    return serializedArray;
  }

  const serializedObject: { [key: string]: JsonSafeValue } = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isNumericKey(key)) {
      continue;
    }

    serializedObject[key] = serializeBigIntsInternal(nestedValue, seen);
  }

  seen.delete(value);
  return serializedObject;
}
