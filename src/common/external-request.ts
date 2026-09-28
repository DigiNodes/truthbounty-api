/**
 * Normalize and validate inbound external request payloads (V2-BE-107 / issue #462).
 * The API must fail closed on malformed input without inventing protocol truth.
 */
export type ExternalRequestShape = {
  method?: string;
  path?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
};

const MAX_STRING = 8_192;
const MAX_KEYS = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function normalizeExternalRequest(input: ExternalRequestShape): ExternalRequestShape {
  const method = String(input.method || "GET").toUpperCase().slice(0, 16);
  const path = String(input.path || "/").slice(0, 2048);
  const headers = normalizeMap(input.headers);
  const query = normalizeMap(input.query);
  const body = normalizeValue(input.body, 0);
  return { method, path, headers, query, body };
}

function normalizeMap(map?: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(map)) return {};
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(map)) {
    if (i++ >= MAX_KEYS) break;
    const key = String(k).toLowerCase().slice(0, 128);
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") continue;
    out[key] = normalizeValue(v, 0);
  }
  return out;
}

function normalizeValue(v: unknown, depth: number): unknown {
  if (depth > 6) return null;
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, MAX_STRING);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => normalizeValue(x, depth + 1));
  if (isPlainObject(v)) return normalizeMap(v);
  return null;
}

export function assertValidExternalRequest(input: ExternalRequestShape): void {
  const n = normalizeExternalRequest(input);
  if (!n.path || !n.path.startsWith("/")) {
    throw new Error("INVALID_EXTERNAL_REQUEST_PATH");
  }
  if (!n.method || !/^[A-Z]+$/.test(n.method)) {
    throw new Error("INVALID_EXTERNAL_REQUEST_METHOD");
  }
}
