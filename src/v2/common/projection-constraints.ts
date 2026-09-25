/**
 * Shared DB-boundary guardrails for V2 protocol projections (issue396).
 *
 * The API indexes, validates, caches, and relays user-signed intent; it never
 * becomes authoritative for protocol settlement, rewards, treasury, or
 * governance. These helpers keep that boundary explicit:
 * - canonical identifiers are derived deterministically from events,
 * - terminal states are immutable (fail closed, observable via anomalies),
 * - failures are bounded and redacted (no raw RPC payloads / secrets in logs).
 *
 * Optimism/EVM semantics are preserved. Stellar, Soroban, and Freighter
 * runtime dependencies are rejected by design (no imports, no branches).
 */

export const KNOWN_PROJECTORS = [
  'v2-evidence',
  'v2-verification',
  'v2-disputes',
] as const;

export type KnownProjector = (typeof KNOWN_PROJECTORS)[number];

export enum TerminalProtection {
  ALLOWED = 'allowed',
  REJECTED_TERMINAL = 'rejected_terminal',
}

/** Dispute lifecycle: RAISED -> RESOLVED | EXPIRED. Terminal states are final. */
export function isDisputeTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true; // idempotent replay
  if (from === 'raised' && (to === 'resolved' || to === 'expired')) return true;
  return false;
}

export function isDisputeTerminal(status: string): boolean {
  return status === 'resolved' || status === 'expired';
}

/** Verification round lifecycle: OPEN -> CLOSED | RESOLVED. Terminal states are final. */
export function isRoundTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === 'open' && (to === 'closed' || to === 'resolved')) return true;
  return false;
}

export function isRoundTerminal(status: string): boolean {
  return status === 'closed' || status === 'resolved';
}

/**
 * Evidence versions are append-only and immutable: no UPDATE/DELETE path
 * exists in the projector. Evidence status may move active <-> removed
 * (Removed marks removed; Registered/Replaced reactivates), so REMOVED is
 * not treated as immutable — only versions are.
 */
export function assertEvidenceVersionImmutable(): never {
  throw new Error(
    'v2_project_evidence_version is append-only: UPDATE/DELETE rejected at DB boundary',
  );
}

/** Derive deterministic dispute id (canonical identifier). */
export function deriveDisputeId(
  claimId: string,
  originalRoundId: string,
): string {
  return `${claimId}:${originalRoundId}`;
}

/**
 * Redact event coordinates for logs: keep short, bounded, non-sensitive
 * identifiers (tx prefix + log index). Never log full payloads, proofs,
 * private keys, or personal data.
 */
export function redactEventCoordinate(
  txHash: string,
  logIndex: number,
): string {
  const prefix = typeof txHash === 'string' ? txHash.slice(0, 10) : '?';
  return `${prefix}…:${logIndex}`;
}

/** Postgres unique-violation + SQLite constraint both mean idempotent replay. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT';
}
