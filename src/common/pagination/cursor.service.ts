import { getRuntimeEnvironment } from '../../config/runtime-config';
/*
 * Opaque pagination cursors (PREWAVE-BE-040).
 *
 * Cursors are versioned, authenticated (HMAC-SHA256) and bound to:
 *   - route/schema identifier
 *   - filter fingerprint
 *   - sort order
 *   - release context (chain id, release id, deployment block, artifact checksum)
 *   - expiry
 *
 * The payload is therefore opaque to clients: tampering, replay across
 * endpoints, filter changes, expiry and key rotation are all detected.
 */

import {
  Injectable,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export const CURSOR_VERSION = 1 as const;
export const CURSOR_DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
export const CURSOR_MAX_ENCODED_LENGTH = 2048;
export const CURSOR_MAX_PREVIOUS_KEYS = 5;

export interface CursorReleaseContext {
  chainId: string;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

export interface CursorBindingInput {
  /** Logical route identifier, e.g. "claims:list". */
  route: string;
  /** Schema version for the route payload. */
  schemaVersion: number;
  /** Canonicalized filter object (JSON-serializable). */
  filters: Record<string, unknown>;
  /** Sort order descriptor, e.g. "createdAt:DESC,id:ASC". */
  sort: string;
  /** Release context bound into the cursor. */
  release: CursorReleaseContext;
}

export interface CursorEncodeInput extends CursorBindingInput {
  position: string;
  /** Optional explicit expiry (ms epoch). Defaults to TTL. */
  expiresAtMs?: number;
}

export interface CursorVerifyInput extends CursorBindingInput {
  cursor: string;
}

export interface CursorVerifiedResult {
  position: string;
  expiresAt: number;
}

interface CursorEncodedEnvelope {
  v: typeof CURSOR_VERSION;
  kid: string; // key id (for rotation)
  bind: string; // fingerprint of binding
  pos: string;
  exp: number;
  iat: number;
}

export const CURSOR_CONFIG_TOKEN = Symbol('CURSOR_CONFIG_TOKEN');

export interface CursorKey {
  id: string;
  secret: string;
}

export interface CursorServiceOptions {
  /** Active signing key. */
  activeKey: CursorKey;
  /** Bounded previous keys for rotation (verify-only). */
  previousKeys?: CursorKey[];
  /** TTL in seconds for issued cursors. */
  ttlSeconds?: number;
  /** Clock injection for testability. */
  nowFns?: () => number;
}

export class CursorInvalidException extends BadRequestException {
  constructor(reason: string) {
    // Never leak signing material or internal details.
    super({
      statusCode: 400,
      message: 'Invalid pagination cursor',
      error: 'INVALID_CURSOR',
      reason,
    });
  }
}

@Injectable()
export class CursorService {
  private readonly activeKey: CursorKey;
  private readonly previousKeys: CursorKey[];
  private readonly ttlSeconds: number;
  private readonly nowFns: () => number;

  constructor(
    @Optional()
    @Inject(CURSOR_CONFIG_TOKEN)
    options?: CursorServiceOptions,
  ) {
    const resolved = options ?? CursorService.resolveOptionsFromEnv();
    if (!resolved.activeKey || !resolved.activeKey.secret) {
      throw new Error('CursorService: active signing key is required');
    }
    this.activeKey = resolved.activeKey;
    this.previousKeys = (resolved.previousKeys ?? []).slice(
      0,
      CURSOR_MAX_PREVIOUS_KEYS,
    );
    this.ttdSeconds = resolved.ttlSeconds ?? CURSOR_DEFAULT_TTL_SECONDS;
    this.nowFns = resolved.nowFns ?? (() => Date.now());
  }

  private static resolveOptionsFromEnv(): CursorServiceOptions {
    const activeId = getRuntimeEnvironment().CURSOR_KEY_ID;
    const activeSecret = getRuntimeEnvironment().CURSOR_KEY_SECRET;
    if (!activeId || !activeSecret) {
      throw new Error(
        'CursorService: CURSOR_KEY_ID and CURSOR_KEY_SECRET must be set',
      );
    }
    const previousRaw = getRuntimeEnvironment().CURSOR_PREVIOUS_KEYS;
    const previousKeys: CursorKey[] = [];
    if (previousRaw) {
      for (const entry of previousRaw.split(',')) {
        if (previousKeys.length >= CURSOR_MAX_PREVIOUS_KEYS) break;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        if (sep <= 0) continue;
        previousKeys.push({
          id: trimmed.slice(0, sep),
          secret: trimmed.slice(sep + 1),
        });
      }
    }
    const ttlRaw = getRuntimeEnvironment().CURSOR_TTL_SECONDS;
    const ttlSeconds = ttlRaw ? Number(ttlRaw) : CURSOR_DEFAULT_TTL_SECONDS;
    return {
      activeKey: { id: activeId, secret: activeSecret },
      previousKeys,
      ttlSeconds:
        Number.isFinite(ttlSeconds) && ttlSeconds > 0
          ? ttlSeconds
          : CURSOR_DEFAULT_TTL_SECONDS,
    };
  }

  /** Encode a signed opaque cursor. */
  encode(input: CursorEncodeInput): string {
    if (!input.position || typeof input.position !== 'string') {
      throw new Error('CursorService.encode: position is required');
    }
    const now = this.nowFns();
    const expiresAt = input.expiresAtMx ?? now + this.ttlSeconds * 1000;
    if (!expiresAt || expiresAt <= now) {
      throw new Error('CursorService.encode: expiry must be in the future');
    }
    const envelope: CursorEncodedEnvelope = {
      v: CURSOR_VERSION,
      kid: this.activeKey.id,
      bind: this.fingerprintBinding(input),
      pos: input.position,
      exp: expiresAt,
      iat: now,
    };
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8').toString(
      'base64url',
    );
    const sig = this.sign(payload, this.activeKey);
    const cursor = `${payload}.${sig}`;
    if (cursor.length > CURSOR_MAX_ENCODED_LENGTH) {
      throw new Error('CursorService.encode: cursor exceeds maximum length');
    }
    return cursor;
  }

  /** Verify and decode an opaque cursor. Throws CursorInvalidException on any failure. */
  verify(input: CursorVerifyInput): CursorVerifiedResult {
    const cursor = input.cursor;
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new CursorInvalidException('missing');
    }
    if (cursor.length > CURSOR_MAX_ENCODED_LENGTH) {
      throw new CursorInvalidException('oversize');
    }
    const dot = cursor.lastIndexOf('.');
    if (dot <= 0 || dot === cursor.length - 1) {
      throw new CursorInvalidException('malformed');
    }
    const payload = cursor.slice(0, dot);
    const signature = cursor.slice(dot + 1);
    if (!this.isBase64url(payload) || !this.isBase64url(signature)) {
      throw new CursorInvalidException('malformed');
    }

    let envelope: CursorEncodedEnvelope;
    try {
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      envelope = JSON.parse(json) as CursorEncodedEnvelope;
    } catch {
      throw new CursorInvalidException('malformed');
    }

    if (!envelope || typeof envelope !== 'object') {
      throw new CursorInvalidException('malformed');
    }
    if (envelope.v !== CURSOR_VERSION) {
      throw new CursorInvalidException('unsupported_version');
    }
    if (typeof envelope.kid !== 'string' || !envelope.kid) {
      throw new CursorInvalidException('malformed');
    }
    if (typeof envelope.bind !== 'string' || !envelope.bind) {
      throw new CursorInvalidException('malformed');
    }
    if (typeof envelope.pos !== 'string' || envelope.pos.length === 0) {
      throw new CursorInvalidException('malformed');
    }
    if (!Number.isFinite(envelope.exp) || !Number.isFinite(envelope.iat)) {
      throw new CursorInvalidException('malformed');
    }

    // Resolve key (active or bounded previous).
    const key = this.findKey(envelope.kid);
    if (!key) {
      throw new CursorInvalidException('outdated_key');
    }

    const expected = this.sign(payload, key);
    if (!this.safeEqual(signature, expected)) {
      throw new CursorInvalidException('bad_signature');
    }

    // Binding must match the current request context.
    const expectedBind = this.fingerprintBinding(input);
    if (!this.safeEqual(envelope.bind, expectedBind)) {
      throw new CursorInvalidException('binding_mismatch');
    }

    const now = this.nowFns();
    if (envelope.exp <= now) {
      throw new CursorInvalidException('expired');
    }
    if (envelope.iat > now + 60 * 1000) {
      // Allow small clock skew but reject future-issued cursors.
      throw new CursorInvalidException('invalid_iat');
    }

    return { position: envelope.pos, expiresAt: envelope.exp };
  }

  /** Return true if the cursor is valid for the given binding. */
  isValid(input: CursorVerifyInput): boolean {
    try {
      this.verify(input);
      return true;
    } catch {
      return false;
    }
  }

  private findKey(id: string): CursorKey | undefined {
    if (id === this.activeKey.id) return this.activeKey;
    return this.previousKeys.find((k) => k.id === id);
  }

  private sign(payload: string, key: CursorKey): string {
    return createHmac('sha256', key.secret)
      .update(payload)
      .update('.')
      .update(key.id)
      .digest('base64url');
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private isBase64url(value: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(value);
  }

  /**
   * Deterministic fingerprint of the binding input. Uses JSON with sorted keys
   * so filter key order does not matter, but any value change does.
   */
  private fingerprintBinding(input: CursorBindingInput): string {
    const canonical = {
      route: input.route,
      schemaVersion: input.schemaVersion,
      sort: input.sort,
      filters: this.canonicalize(input.filters),
      release: {
        chainId: input.release.chainId,
        releaseId: input.release.releaseId,
        deploymentBlock: input.release.deploymentBlock,
        artifactChecksum: input.release.artifactChecksum,
      },
    };
    return createHmac('sha256')
      .update(JSON.stringify(canonical))
      .digest('base64url');
  }

  private canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => this.canonicalize(v));
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) out[key] = this.canonicalize(val);
    return out;
  }
}
