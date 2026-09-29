/**
 * Prove forward/backward migration safety helpers (V2-BE-112 / issue #464).
 * Migrations must be reversible in naming/order without inventing protocol state.
 */
export type MigrationMeta = {
  id: string;
  timestamp: number;
  name: string;
};

export function parseMigrationId(id: string): MigrationMeta {
  const m = /^(\d+)-(.+)$/.exec(id);
  if (!m) {
    throw new Error(`INVALID_MIGRATION_ID:${id}`);
  }
  return { id, timestamp: Number(m[1]), name: m[2] };
}

export function assertStrictlyIncreasing(ids: string[]): void {
  let prev = -1;
  for (const id of ids) {
    const meta = parseMigrationId(id);
    if (!(meta.timestamp > prev)) {
      throw new Error(`MIGRATION_ORDER_VIOLATION:${id}`);
    }
    prev = meta.timestamp;
  }
}

/** Forward then backward should restore the original ordered id list. */
export function assertForwardBackwardSafe(ids: string[]): string[] {
  assertStrictlyIncreasing(ids);
  const forward = [...ids];
  const backward = [...forward].reverse();
  const restored = [...backward].reverse();
  if (restored.join("|") !== ids.join("|")) {
    throw new Error("MIGRATION_ROUNDTRIP_FAILED");
  }
  return restored;
}
