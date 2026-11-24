import { Buffer } from 'buffer';

export interface DisputeListCursor {
  v: 1;
  disputeId: string;
  snapshotAt: string;
  order: string;
  chainId: number;
  status: string | null;
}

export function encodeDisputeListCursor(cursor: DisputeListCursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf-8').toString('base64url');
}

export function decodeDisputeListCursor(encoded: string): DisputeListCursor {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid cursor: not an object');
    }

    const cursor = parsed as Record<string, unknown>;

    if (cursor.v !== 1) {
      throw new Error(`Invalid cursor version: ${cursor.v}`);
    }

    if (typeof cursor.disputeId !== 'string') {
      throw new Error('Invalid cursor: disputeId must be a string');
    }

    if (typeof cursor.snapshotAt !== 'string') {
      throw new Error('Invalid cursor: snapshotAt must be a string');
    }

    if (typeof cursor.order !== 'string') {
      throw new Error('Invalid cursor: order must be a string');
    }

    if (typeof cursor.chainId !== 'number') {
      throw new Error('Invalid cursor: chainId must be a number');
    }

    if (cursor.status !== null && typeof cursor.status !== 'string') {
      throw new Error('Invalid cursor: status must be a string or null');
    }

    return {
      v: 1,
      disputeId: cursor.disputeId,
      snapshotAt: cursor.snapshotAt,
      order: cursor.order,
      chainId: cursor.chainId,
      status: cursor.status ?? null,
    };
  } catch (err) {
    throw new Error(`Failed to decode cursor: ${err instanceof Error ? err.message : String(err)}`);
  }
}
