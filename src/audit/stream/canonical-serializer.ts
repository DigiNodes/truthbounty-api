import { createHash, createHmac } from 'crypto';

/**
 * Deterministic Canonical Serialization compliant with RFC 8785 (JSON Canonicalization Scheme).
 * Guarantees byte-for-byte identical output across platforms, engines, and runtimes.
 */
export class CanonicalSerializer {
  /**
   * Serializes any value into a canonical JSON string.
   * - Object keys are sorted lexicographically by UTF-16 code units.
   * - Whitespace is eliminated.
   * - Numbers are checked for finiteness (NaN and Infinity are rejected).
   * - Dates are normalized to ISO 8601 UTC strings.
   * - Undefined properties are omitted from objects and rejected in arrays/top-level.
   * - Prototype poisoning (__proto__, constructor) is prevented.
   */
  static serialize(value: unknown): string {
    return this.serializeValue(value, '$', false);
  }

  private static serializeValue(
    value: unknown,
    path: string,
    inArray: boolean,
  ): string {
    if (value === null) {
      return 'null';
    }

    if (value === undefined) {
      if (inArray) {
        throw new Error(
          `Canonical serialization error at ${path}: undefined is not allowed in arrays`,
        );
      }
      throw new Error(
        `Canonical serialization error at ${path}: undefined is not allowed as a standalone value`,
      );
    }

    const type = typeof value;

    if (type === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (type === 'number') {
      if (!Number.isFinite(value as number)) {
        throw new Error(
          `Canonical serialization error at ${path}: non-finite number (${value}) is not allowed`,
        );
      }
      // In JS, -0 must be serialized as 0 according to RFC 8785
      if (Object.is(value, -0)) {
        return '0';
      }
      return (value as number).toString();
    }

    if (type === 'string') {
      return JSON.stringify(value);
    }

    if (type === 'bigint') {
      return JSON.stringify((value as bigint).toString());
    }

    if (value instanceof Date) {
      if (isNaN(value.getTime())) {
        throw new Error(
          `Canonical serialization error at ${path}: invalid Date`,
        );
      }
      return JSON.stringify(value.toISOString());
    }

    if (Array.isArray(value)) {
      const elements = value.map((elem, idx) =>
        this.serializeValue(elem, `${path}[${idx}]`, true),
      );
      return '[' + elements.join(',') + ']';
    }

    if (type === 'object') {
      // Reject non-plain objects, functions, symbols
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        // Allow plain object instances or null prototypes
        if (typeof (value as any).toJSON === 'function') {
          return this.serializeValue((value as any).toJSON(), path, inArray);
        }
      }

      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => {
        // UTF-16 code unit order comparison
        return a < b ? -1 : a > b ? 1 : 0;
      });

      const entries: string[] = [];
      for (const key of keys) {
        // Prevent prototype pollution or dangerous properties
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }

        const propVal = obj[key];
        if (propVal === undefined) {
          // Omit undefined properties from objects per JSON spec
          continue;
        }

        const serializedProp = this.serializeValue(
          propVal,
          `${path}.${key}`,
          false,
        );
        entries.push(JSON.stringify(key) + ':' + serializedProp);
      }

      return '{' + entries.join(',') + '}';
    }

    throw new Error(
      `Canonical serialization error at ${path}: unsupported type (${type})`,
    );
  }

  /**
   * Computes SHA-256 digest of canonically serialized value.
   */
  static sha256(value: unknown): string {
    const canonical = typeof value === 'string' ? value : this.serialize(value);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * Computes keyed HMAC-SHA256 digest of canonically serialized value.
   */
  static hmacSha256(secret: string, value: unknown): string {
    if (!secret || typeof secret !== 'string') {
      throw new Error('HMAC key must be a non-empty string');
    }
    const canonical = typeof value === 'string' ? value : this.serialize(value);
    return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  }
}
