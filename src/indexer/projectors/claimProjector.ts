import { ClaimState, isTransitionAllowed } from '../../domain/claim/claimState';
import {
  ClaimLifecycleEventType,
  EVENT_TYPE_TO_STATE,
} from '../../domain/claim/canonical-claim-event';

interface ClaimEventLogRecord {
  processedAt?: Date | null;
  state?: unknown;
  updatedAtBlock?: bigint;
  lastEventLogIndex?: number;
}

interface ClaimRecord {
  state: unknown;
  updatedAtBlock: bigint;
  lastEventLogIndex: number;
}

interface DbClient {
  claimEventLog: {
    findUnique(args: unknown): Promise<ClaimEventLogRecord | null>;
    upsert(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
  };
  claimRecord: {
    findUnique(args: unknown): Promise<ClaimRecord | null>;
    upsert(args: unknown): Promise<unknown>;
  };
}

class InvalidClaimTransitionError extends Error {
  constructor(claimId: string, from: unknown, to: unknown, txHash: string) {
    super(
      `Invalid claim transition for ${claimId}: ${String(from)} -> ${String(to)} (${txHash})`,
    );
    this.name = 'InvalidClaimTransitionError';
  }
}

function mapEventToState(eventName: string): ClaimState {
  return EVENT_TYPE_TO_STATE[eventName as ClaimLifecycleEventType];
}

function buildInitialRecord(evt: CanonicalClaimEvent): Record<string, unknown> {
  return {
    id: evt.claimId,
    state: mapEventToState(evt.eventName),
    updatedAtBlock: evt.blockNumber,
    lastEventLogIndex: evt.logIndex,
    txHash: evt.txHash,
    payload: evt.payload,
  };
}

function buildStateUpdate(evt: CanonicalClaimEvent, nextState: ClaimState): Record<string, unknown> {
  return {
    state: nextState,
    updatedAtBlock: evt.blockNumber,
    lastEventLogIndex: evt.logIndex,
    txHash: evt.txHash,
    payload: evt.payload,
  };
}

interface CanonicalClaimEvent {
  claimId: string;
  eventName: string;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  payload: Record<string, unknown>;
}

export async function projectClaimEvent(db: DbClient, evt: CanonicalClaimEvent) {
  // 1. Idempotency: never process the same log twice on replay
  const existing = await db.claimEventLog.findUnique({
    where: { txHash_logIndex: { txHash: evt.txHash, logIndex: evt.logIndex } },
  });
  if (existing?.processedAt) return;

  await db.claimEventLog.upsert({
    where: { txHash_logIndex: { txHash: evt.txHash, logIndex: evt.logIndex } },
    create: { claimId: evt.claimId, eventName: evt.eventName, blockNumber: evt.blockNumber,
              logIndex: evt.logIndex, txHash: evt.txHash, payload: evt.payload },
    update: {},
  });

  const nextState = mapEventToState(evt.eventName);
  const current = await db.claimRecord.findUnique({ where: { id: evt.claimId } });

  // 2. Ordering guard: ignore stale/out-of-order re-delivery
  if (current && isStaleOrDuplicate(current, evt)) {
    await db.claimEventLog.update({
      where: { txHash_logIndex: { txHash: evt.txHash, logIndex: evt.logIndex } },
      data: { processedAt: new Date() },
    });
    return;
  }

  // 3. Reject impossible transitions instead of silently applying them
  if (current && !isTransitionAllowed(current.state as ClaimState, nextState)) {
    throw new InvalidClaimTransitionError(evt.claimId, current.state, nextState, evt.txHash);
  }

  await db.claimRecord.upsert({
    where: { id: evt.claimId },
    create: buildInitialRecord(evt),
    update: buildStateUpdate(evt, nextState),
  });

  await db.claimEventLog.update({
    where: { txHash_logIndex: { txHash: evt.txHash, logIndex: evt.logIndex } },
    data: { processedAt: new Date() },
  });
}

function isStaleOrDuplicate(current: { updatedAtBlock: bigint; lastEventLogIndex: number },
                             evt: CanonicalClaimEvent): boolean {
  if (evt.blockNumber < current.updatedAtBlock) return true;
  if (evt.blockNumber === current.updatedAtBlock && evt.logIndex <= current.lastEventLogIndex) return true;
  return false;
}
