import { ClaimReadModel } from '../../entities/claim-read-model.entity';
import { ClaimState } from '../../../domain/claim/claimState';
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
  artifactVersion: '2.0.0-rc.3',
  claimRegistryAddress: '0x0000000000000000000000000000000000001001',
  verdictContractAddress: '0x0000000000000000000000000000000000001002',
  deploymentBlock: 24850000,
  artifactChecksum: 'f'.repeat(64),
};

function row(overrides: Partial<ClaimReadModel> = {}): ClaimReadModel {
  return {
    id: 'row-1',
    claimId: 'claim-1',
    chainId: '11155420',
    state: ClaimState.Submitted,
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
    expect(deriveClaimPhase(ClaimState.Finalized, DataState.FINALIZED)).toBe(
      'finalized',
    );
    expect(deriveClaimPhase(ClaimState.Rejected, DataState.FINALIZED)).toBe(
      'provisional',
    );
    expect(deriveClaimPhase(ClaimState.Reorged, DataState.FINALIZED)).toBe(
      'provisional',
    );
  });

  it('keeps a terminal-but-not-yet-final state provisional', () => {
    expect(deriveClaimPhase(ClaimState.Finalized, DataState.SAFE)).toBe(
      'provisional',
    );
    expect(deriveClaimPhase(ClaimState.Finalized, DataState.OBSERVED)).toBe(
      'provisional',
    );
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
    expect(isTerminalClaimState(ClaimState.Finalized)).toBe(true);
    expect(isTerminalClaimState(ClaimState.Rejected)).toBe(false);
    expect(isTerminalClaimState(ClaimState.Reorged)).toBe(false);
    expect(isTerminalClaimState(ClaimState.Submitted)).toBe(false);
  });
});

describe('toClaimReadModelItem', () => {
  it('emits exactly the published item keys', () => {
    const item = toClaimReadModelItem(row(), {
      provenance: PROVENANCE,
      dataState: DataState.OBSERVED,
      canonicalVerdictCode: null,
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
      canonicalVerdictCode: null,
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
      provisional: {
        state: ClaimState.Submitted,
        settledAt: null,
        verdictCode: null,
      },
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
        state: ClaimState.Finalized,
        settledAt: new Date('2026-10-16T12:00:00.000Z'),
      }),
      {
        provenance: PROVENANCE,
        dataState: DataState.FINALIZED,
        canonicalVerdictCode: '2',
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
      state: ClaimState.Finalized,
      settledAt: '2026-10-16T12:00:00.000Z',
      verdictCode: '2',
    });
    expect(item.deadlines.settledAt).toBe('2026-10-16T12:00:00.000Z');
  });

  it('rejects finalized phase without a canonical finalized verdict code', () => {
    expect(() =>
      toClaimReadModelItem(
        row({
          state: ClaimState.Finalized,
          settledAt: new Date('2026-10-16T12:00:00.000Z'),
        }),
        {
          provenance: PROVENANCE,
          dataState: DataState.FINALIZED,
          canonicalVerdictCode: null,
          evidence: {
            state: 'available',
            activeCount: 2,
            finalizedCount: 2,
            latestBlockNumber: '24850012',
          },
          deadlines: { verification: null, appeal: null, settledAt: null },
        },
      ),
    ).toThrow('Finalized claim read model requires a canonical verdict code');
  });

  it('tolerates a null stateChangedAt without throwing', () => {
    const item = toClaimReadModelItem(
      row({ stateChangedAt: null as unknown as Date }),
      {
        provenance: PROVENANCE,
        dataState: DataState.OBSERVED,
        canonicalVerdictCode: null,
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
