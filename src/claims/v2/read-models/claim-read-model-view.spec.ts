import { ClaimReadModel } from '../../entities/claim-read-model.entity';
import { DataState } from '../../../v2/common/data-state.enum';
import {
  CLAIM_READ_MODEL_ITEM_KEYS,
  CLAIM_READ_MODEL_PROVENANCE_KEYS,
  ReleaseProvenance,
} from './claim-read-model.types';
import {
  deriveClaimPhase,
  isTerminalClaimState,
  toClaimReadModelItem,
} from './claim-read-model-view';

const PROVENANCE: ReleaseProvenance = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  deploymentBlock: 24850000,
  artifactChecksum: 'f'.repeat(64),
};

function row(overrides: Partial<ClaimReadModel> = {}): ClaimReadModel {
  return {
    id: 'row-1',
    claimId: 'claim-1',
    chainId: '11155420',
    state: 'UNDER_VERIFICATION' as ClaimReadModel['state'],
    blockNumber: '24850010',
    eventTxHash: '0x' + 'a'.repeat(64),
    eventIndex: 2,
    stateChangedAt: new Date('2026-10-15T00:00:00.000Z'),
    settledAt: null,
    createdAt: new Date('2026-10-15T00:00:00.000Z'),
    updatedAt: new Date('2026-10-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('deriveClaimPhase', () => {
  it('only finalizes a terminal state whose block is chain-finalized', () => {
    expect(deriveClaimPhase('SETTLED', DataState.FINALIZED)).toBe('finalized');
    expect(deriveClaimPhase('REJECTED', DataState.FINALIZED)).toBe('finalized');
    expect(deriveClaimPhase('EXPIRED', DataState.FINALIZED)).toBe('finalized');
  });

  it('keeps a terminal-but-not-yet-final state provisional', () => {
    expect(deriveClaimPhase('SETTLED', DataState.SAFE)).toBe('provisional');
    expect(deriveClaimPhase('SETTLED', DataState.OBSERVED)).toBe('provisional');
  });

  it('keeps non-terminal states provisional even when finalized', () => {
    expect(deriveClaimPhase('SUBMITTED', DataState.FINALIZED)).toBe(
      'provisional',
    );
    expect(deriveClaimPhase('DISPUTED', DataState.FINALIZED)).toBe(
      'provisional',
    );
  });

  it('classifies terminal states explicitly', () => {
    expect(isTerminalClaimState('SETTLED')).toBe(true);
    expect(isTerminalClaimState('REJECTED')).toBe(true);
    expect(isTerminalClaimState('EXPIRED')).toBe(true);
    expect(isTerminalClaimState('UNDER_VERIFICATION')).toBe(false);
  });
});

describe('toClaimReadModelItem', () => {
  it('emits exactly the published item keys', () => {
    const item = toClaimReadModelItem(row(), {
      provenance: PROVENANCE,
      dataState: DataState.OBSERVED,
      evidence: {
        state: 'missing',
        activeCount: 0,
        finalizedCount: 0,
        latestBlockNumber: null,
      },
      deadlines: { verification: null, appeal: null, settledAt: null },
    });

    expect(Object.keys(item).sort()).toEqual(
      [...CLAIM_READ_MODEL_ITEM_KEYS].sort(),
    );
    expect(Object.keys(item.release).sort()).toEqual(
      [...CLAIM_READ_MODEL_PROVENANCE_KEYS].sort(),
    );
  });

  it('maps a provisional row without exposing a final outcome', () => {
    const item = toClaimReadModelItem(row(), {
      provenance: PROVENANCE,
      dataState: DataState.SAFE,
      evidence: {
        state: 'not_finalized',
        activeCount: 1,
        finalizedCount: 0,
        latestBlockNumber: '24850010',
      },
      deadlines: {
        verification: '2026-10-20T00:00:00.000Z',
        appeal: null,
        settledAt: null,
      },
    });

    expect(item.phase).toBe('provisional');
    expect(item.outcome).toEqual({
      phase: 'provisional',
      provisional: { state: 'UNDER_VERIFICATION', settledAt: null },
      final: null,
    });
    expect(item.lastEvent).toEqual({
      blockNumber: '24850010',
      eventIndex: 2,
      txHash: '0x' + 'a'.repeat(64),
      at: '2026-10-15T00:00:00.000Z',
    });
    expect(item.deadlines.verification).toBe('2026-10-20T00:00:00.000Z');
    expect(item.release).toEqual(PROVENANCE);
  });

  it('maps a finalized row without exposing a provisional outcome', () => {
    const item = toClaimReadModelItem(
      row({
        state: 'SETTLED' as ClaimReadModel['state'],
        settledAt: new Date('2026-10-16T12:00:00.000Z'),
      }),
      {
        provenance: PROVENANCE,
        dataState: DataState.FINALIZED,
        evidence: {
          state: 'available',
          activeCount: 2,
          finalizedCount: 2,
          latestBlockNumber: '24850012',
        },
        deadlines: { verification: null, appeal: null, settledAt: null },
      },
    );

    expect(item.phase).toBe('finalized');
    expect(item.outcome.provisional).toBeNull();
    expect(item.outcome.final).toEqual({
      state: 'SETTLED',
      settledAt: '2026-10-16T12:00:00.000Z',
    });
    expect(item.deadlines.settledAt).toBe('2026-10-16T12:00:00.000Z');
  });

  it('tolerates a null stateChangedAt without throwing', () => {
    const item = toClaimReadModelItem(
      row({ stateChangedAt: null as unknown as Date }),
      {
        provenance: PROVENANCE,
        dataState: DataState.OBSERVED,
        evidence: {
          state: 'missing',
          activeCount: 0,
          finalizedCount: 0,
          latestBlockNumber: null,
        },
        deadlines: { verification: null, appeal: null, settledAt: null },
      },
    );
    expect(item.lastEvent.at).toBe(new Date(0).toISOString());
  });
});
