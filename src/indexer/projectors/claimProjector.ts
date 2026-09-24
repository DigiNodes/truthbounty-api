import { ClaimState, isTransitionAllowed } from '../../domain/claim/claimState';

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
