import { Injectable } from '@nestjs/common';

export interface KeyEntry {
  keyId: string;
  secret: string;
  active: boolean;
  createdAt: string;
  retiredAt?: string;
}

/**
 * Key Registry providing rotation support for audit stream HMAC verification.
 * Fails closed on missing, ambiguous, or empty keys.
 */
@Injectable()
export class AuditKeyRegistry {
  private readonly keys = new Map<string, KeyEntry>();
  private activeKeyId: string | null = null;

  constructor(initialKeys?: Array<{ keyId: string; secret: string; active?: boolean }>) {
    if (initialKeys && initialKeys.length > 0) {
      for (const k of initialKeys) {
        this.registerKey(k.keyId, k.secret, k.active ?? false);
      }
      if (!this.activeKeyId) {
        // Default the last registered key as active if none was explicitly marked active
        const last = initialKeys[initialKeys.length - 1];
        this.setActiveKey(last.keyId);
      }
    }
  }

  registerKey(keyId: string, secret: string, active: boolean = false): void {
    if (!keyId || typeof keyId !== 'string' || keyId.trim().length === 0) {
      throw new Error('Key ID must be a non-empty string');
    }
    if (!secret || typeof secret !== 'string' || secret.length < 16) {
      throw new Error('Secret must be at least 16 characters for secure HMAC');
    }

    const entry: KeyEntry = {
      keyId,
      secret,
      active,
      createdAt: new Date().toISOString(),
    };

    this.keys.set(keyId, entry);

    if (active) {
      this.setActiveKey(keyId);
    }
  }

  setActiveKey(keyId: string): void {
    const entry = this.keys.get(keyId);
    if (!entry) {
      throw new Error(`Cannot activate non-existent key: ${keyId}`);
    }

    // Deactivate previous active key
    if (this.activeKeyId && this.activeKeyId !== keyId) {
      const prev = this.keys.get(this.activeKeyId);
      if (prev) {
        prev.active = false;
        prev.retiredAt = new Date().toISOString();
      }
    }

    entry.active = true;
    this.activeKeyId = keyId;
  }

  getActiveKey(): KeyEntry {
    if (!this.activeKeyId) {
      throw new Error('No active audit key configured in key registry');
    }
    const entry = this.keys.get(this.activeKeyId);
    if (!entry || !entry.active) {
      throw new Error(`Active audit key ${this.activeKeyId} is invalid or inactive`);
    }
    return entry;
  }

  getKey(keyId: string): KeyEntry | undefined {
    return this.keys.get(keyId);
  }

  hasKey(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  rotateKey(newKeyId: string, newSecret: string): void {
    this.registerKey(newKeyId, newSecret, true);
  }

  getAllKeyIds(): string[] {
    return Array.from(this.keys.keys());
  }
}
