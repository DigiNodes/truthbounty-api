import type {
  DisputeReadModel,
  SettlementOutcome,
  BondDisposition,
} from './dispute-read-model.service';

import type { Provenance, FinalityStatus } from './dispute-read-model.service';

export interface ProvenanceChain {
  readonly chainId: string;
  readonly releaseId: string;
}

export interface FinalityCheckpoint {
  readonly finalityCheckpoint: string;
  readonly finalityStatus: FinalityStatus;
}

export interface DisputeProjectionFixture {
  readonly name: string;
  readonly provenanceChain: ProvenanceChain;
  readonly finality: FinalityCheckpoint;
  readonly expected: DisputeReadModel;
}

const chain: ProvenanceChain = {
  chainId: 'chain-main-1',
  releaseId: 'release-2024-01',
};

const finality: FinalityCheckpoint = {
  finalityCheckpoint: '2024-06-01T00:00:00.000Z',
  finalityStatus: 'finalized',
};

const provenance: Provenance = {
  chainId: chain.chainId,
  releaseId: chain.releaseId,
  eventId: 'tx-0xabc#12',
  finalityCheckpoint: finality.finalityCheckpoint,
  finalityStatus: finality.finalityStatus,
};

const settlementOutcome: SettlementOutcome = 'resolved_in_favor_of_claimant';
const bondDisposition: BondDisposition = 'returned_to_claimant';

export const disputeProjectionFixtures: ReadonlyArray<DisputeProjectionFixture> = [
  {
    name: 'open-appeal',
    provenanceChain: chain,
    finality,
    expected: {
      disputeId: 'dispute-1',
      appeal: {
        deadline: '2024-06-15T00:00:00.000Z',
        status: 'open',
        provenance,
      },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'provisional',
    },
  },
  {
    name: 'expired-appeal',
    provenanceChain: chain,
    finality,
    expected: {
      disputeId: 'dispute-2',
      appeal: {
        deadline: '2024-05-01T00:00:00.000Z',
        status: 'expired',
        provenance,
      },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'provisional',
    },
  },
  {
    name: 'appealed',
    provenanceChain: chain,
    finality,
    expected: {
      disputeId: 'dispute-3',
      appeal: {
        deadline: '2024-06-20T00:00:00.000Z',
        status: 'appealed',
        provenance,
      },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'provisional',
    },
  },
  {
    name: 'provisional-settlement',
    provenanceChain: chain,
    finality: {
      finalityCheckpoint: '2024-06-01T00:00:00.000Z',
      finalityStatus: 'provisional',
    },
    expected: {
      disputeId: 'dispute-4',
      appeal: { deadline: null, status: 'unknown', provenance: null },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'unavailable',
    },
  },
  {
    name: 'finalized-settlement',
    provenanceChain: chain,
    finality,
    expected: {
      disputeId: 'dispute-5',
      appeal: { deadline: null, status: 'unknown', provenance: null },
      settlement: { outcome: settlementOutcome, bondDisposition, rovenance },
      finalityStatus: 'finalized',
    },
  },
  {
    name: 'reorg',
    provenanceChain: chain,
    finality: {
      finalityCheckpoint: '2024-06-01T00:00:00.000Z',
      finalityStatus: 'reorged',
    },
    expected: {
      disputeId: 'dispute-6',
      appeal: { deadline: null, status: 'unknown', provenance: null },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'unavailable',
    },
  },
  {
    name: 'stale-projection',
    provenanceChain: chain,
    finality: {
      finalityCheckpoint: '2024-06-01T00:00:00.000Z',
      finalityStatus: 'stale',
    },
    expected: {
      disputeId: 'dispute-7',
      appeal: { deadline: null, status: 'unknown', provenance: null },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'unavailable',
    },
  },
  {
    name: 'unavailable-source',
    provenanceChain: chain,
    finality: {
      finalityCheckpoint: '2024-06-01T00:00:00.000Z',
      finalityStatus: 'unavailable',
    },
    expected: {
      disputeId: 'dispute-8',
      appeal: { deadline: null, status: 'unknown', provenance: null },
      settlement: { outcome: 'unknown', bondDisposition: 'unknown', provenance: null },
      finalityStatus: 'unavailable',
    },
  },
];
