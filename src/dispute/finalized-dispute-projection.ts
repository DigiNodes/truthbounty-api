/** Pure replay of the canonical journal. No HTTP or wall-clock inputs. */
export interface DisputeRelease {
  chainId: number;
  releaseId: string;
  contractAddress: string;
  deploymentBlock: bigint;
  decoderVersion: string;
}

export interface DisputeEvent {
  chainId: number;
  releaseId: string | null;
  contractAddress: string;
  decoderVersion: string;
  eventName: string;
  blockNumber: string;
  blockHash: string;
  txHash: string;
  logIndex: number;
  payload: string;
  removed: boolean;
}

export const DISPUTE_EVENTS = [
  'DisputeRaised',
  'DisputeResolved',
  'DisputeExpired',
];

export interface DisputeProvenance {
  chainId: number;
  releaseId: string;
  contractAddress: string;
  deploymentBlock: string;
  decoderVersion: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}

export interface ProtocolDispute {
  disputeId: string;
  claimId: string;
  roundId: string;
  authority: 'finalized_contract_events';
  status: 'OPEN' | 'RESOLVED' | 'EXPIRED';
  initiator: string | null;
  trigger: string | null;
  originalConfidence: number | null;
  finalConfidence: number | null;
  outcome: string | null;
  deadline: string | null;
  bond: {
    amount: string | null;
    asset: string | null;
    disposition: string | null;
  };
  settlement: string | null;
  provenance: DisputeProvenance[];
}

function text(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function confidence(
  payload: Record<string, unknown>,
  name: string,
): number | null {
  const value = payload[name];
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

/** Missing fields stay unknown; expiry does not imply refund or settlement. */
export function replayDisputes(
  events: DisputeEvent[],
  release: DisputeRelease,
  finalizedBlock: bigint,
  canonicalHashes: ReadonlyMap<string, string>,
): ProtocolDispute[] {
  const selected = events
    .filter(
      (event) =>
        !event.removed &&
        event.chainId === release.chainId &&
        event.releaseId === release.releaseId &&
        event.contractAddress.toLowerCase() ===
          release.contractAddress.toLowerCase() &&
        event.decoderVersion === release.decoderVersion &&
        DISPUTE_EVENTS.includes(event.eventName),
    )
    .filter((event) => {
      if (
        !/^\d+$/.test(event.blockNumber) ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        !/^0x[\da-f]{64}$/i.test(event.blockHash) ||
        !/^0x[\da-f]{64}$/i.test(event.txHash)
      ) {
        throw new Error('Invalid canonical dispute event identity');
      }
      const height = BigInt(event.blockNumber);
      return (
        height >= release.deploymentBlock &&
        height <= finalizedBlock &&
        canonicalHashes.get(event.blockNumber)?.toLowerCase() ===
          event.blockHash.toLowerCase()
      );
    })
    .sort((a, b) => {
      const height = BigInt(a.blockNumber) - BigInt(b.blockNumber);
      return height < 0n ? -1 : height > 0n ? 1 : a.logIndex - b.logIndex;
    });

  const seen = new Map<string, string>();
  const positions = new Map<string, string>();
  const disputes = new Map<string, ProtocolDispute>();
  for (const event of selected) {
    const identity = `${event.blockHash.toLowerCase()}:${event.txHash.toLowerCase()}:${event.logIndex}`;
    const fingerprint = JSON.stringify([event.eventName, event.payload]);
    if (seen.has(identity)) {
      if (seen.get(identity) !== fingerprint)
        throw new Error('Conflicting duplicate dispute event');
      continue;
    }
    const position = `${event.blockNumber}:${event.logIndex}`;
    if (positions.has(position))
      throw new Error('Conflicting canonical log position');
    seen.set(identity, fingerprint);
    positions.set(position, identity);
    const payload: unknown = JSON.parse(event.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Invalid dispute payload');
    const fields = payload as Record<string, unknown>;
    const claimId = text(fields, 'claimId');
    const roundId = text(fields, 'roundId');
    if (!claimId || !roundId)
      throw new Error('Dispute event missing claim or round');
    const disputeId = JSON.stringify([claimId, roundId]);
    const provenance: DisputeProvenance = {
      chainId: release.chainId,
      releaseId: release.releaseId,
      contractAddress: release.contractAddress.toLowerCase(),
      deploymentBlock: release.deploymentBlock.toString(),
      decoderVersion: release.decoderVersion,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash.toLowerCase(),
      transactionHash: event.txHash.toLowerCase(),
      logIndex: event.logIndex,
    };
    if (event.eventName === 'DisputeRaised') {
      if (disputes.has(disputeId))
        throw new Error('Multiple raises for one dispute');
      disputes.set(disputeId, {
        disputeId,
        claimId,
        roundId,
        authority: 'finalized_contract_events',
        status: 'OPEN',
        initiator: text(fields, 'challenger'),
        trigger: text(fields, 'trigger'),
        originalConfidence: confidence(fields, 'originalConfidence'),
        finalConfidence: null,
        outcome: null,
        deadline: text(fields, 'deadline'),
        bond: {
          amount: text(fields, 'bondAmount'),
          asset: text(fields, 'bondAsset'),
          disposition: null,
        },
        settlement: null,
        provenance: [provenance],
      });
      continue;
    }
    const dispute = disputes.get(disputeId);
    if (!dispute || dispute.status !== 'OPEN')
      throw new Error('Invalid canonical dispute transition');
    dispute.status =
      event.eventName === 'DisputeResolved' ? 'RESOLVED' : 'EXPIRED';
    dispute.outcome = text(fields, 'outcome');
    dispute.finalConfidence = confidence(fields, 'finalConfidence');
    dispute.bond.disposition = text(fields, 'bondDisposition');
    dispute.settlement = text(fields, 'settlement');
    dispute.provenance.push(provenance);
  }
  return [...disputes.values()];
}
