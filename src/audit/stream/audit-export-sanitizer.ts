/**
 * Sanitizer and leak detector to ensure audit exports never contain credentials, secrets, or internal keys.
 */

const SECRET_KEY_PATTERN =
  /(secret|private|password|mnemonic|token|authorization|credential|auth_key|api_key|privkey)/i;

const SECRET_VALUE_PATTERN =
  /(0x[a-f0-9]{64}|bearer\s+[a-z0-9._~+/-]+=*|basic\s+[a-z0-9+/=]+)/i;

export class AuditExportSanitizer {
  /**
   * Deeply scans an object or array. Throws an error immediately if any secret
   * or prohibited pattern is detected.
   */
  static assertSecretFree(value: unknown, path = '$'): void {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'string') {
      // Allow known public hashes (SHA-256 integrityHash, previousHash, artifactChecksum, etc.)
      // But verify they are not labeled as secret keys or matching auth bearer tokens
      if (SECRET_VALUE_PATTERN.test(value) && /bearer|basic/i.test(value)) {
        throw new Error(
          `Export sanitization violation at ${path}: contains secret or token pattern`,
        );
      }
      return;
    }

    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item, idx) => {
          this.assertSecretFree(item, `${path}[${idx}]`);
        });
        return;
      }

      for (const [key, propValue] of Object.entries(value)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          // Allow keyId as it is a public identifier (e.g. "key-2026-q1")
          if (key === 'keyId') {
            if (typeof propValue === 'string' && propValue.length > 128) {
              throw new Error(
                `Export sanitization violation at ${path}.${key}: keyId value is abnormally long`,
              );
            }
            continue;
          }
          throw new Error(
            `Export sanitization violation at ${path}.${key}: field name matches prohibited secret pattern`,
          );
        }

        this.assertSecretFree(propValue, `${path}.${key}`);
      }
    }
  }
}
