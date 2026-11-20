import { GovernanceReadService } from '../governance-read.service';
import { ProposalChainState } from '../entities/governance-proposal.entity';

/**
 * Read-side coverage for PREWAVE-BE-192: a request must observe one committed
 * proposal/action snapshot even if a projector commits midway through it.
 */
describe('GovernanceReadService', () => {
  const CHAIN_ID = 11155420;
  const PROPOSAL_ID = '1';

  function makeSnapshotRunner(
    proposalRows: any[],
    actionRows: any[],
    onProposalRead?: () => void,
  ) {
    const isolationLevels: any[] = [];
    let onProposalReadCalled = false;
    const run = jest.fn(async (callback: (manager: any) => Promise<any>, options?: any) => {
      isolationLevels.push(options?.isolationLevel);
      // REPEATABLE READ snapshot taken when the request's transaction opens.
      const proposalSnapshot = proposalRows.map((row) => ({ ...row }));
      const actionSnapshot = actionRows.map((row) => ({ ...row }));
      const manager = {
        getRepository: (entity: any) => {
          switch (entity?.name) {
            case 'GovernanceProposal':
              return {
                findOne: jest.fn(async ({ where }: any) => {
                  const found = proposalSnapshot.find((row) =>
                    Object.entries(where).every(([k, v]) => row[k] === v),
                  ) ?? null;
                  if (found && onProposalRead && !onProposalReadCalled) {
                    onProposalReadCalled = true;
                    onProposalRead();
                  }
                  return found;
                }),
              };
            case 'GovernanceAction':
              return {
                find: jest.fn(async ({ where }: any) =>
                  actionSnapshot
                    .filter((row) =>
                      Object.entries(where ?? {}).every(
                        ([k, v]) => row[k] === v,
                      ),
                    )
                    .sort((a, b) => a.actionIndex - b.actionIndex),
                ),
              };
            case 'ProposalVote':
              return { find: jest.fn(async () => []) };
            default:
              throw new Error(`Unexpected repository: ${entity?.name}`);
          }
        },
      };
      return callback(manager);
    });
    return { run, isolationLevels } as any;
  }

  function makeService(txRunner: any) {
    return new GovernanceReadService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      txRunner,
    );
  }

  function makeProposal() {
    return {
      id: 'p-1',
      chainId: CHAIN_ID,
      proposalId: PROPOSAL_ID,
      governorAddress: '0x0000000000000000000000000000000000001001',
      proposer: '0x1111111111111111111111111111111111111111',
      proposalHash: '0xdeadbeef',
      description: 'test',
      state: ProposalChainState.PENDING,
      eta: null,
      stateChangedAtBlock: '100',
      stateChangedAt: new Date('2026-01-01T00:00:00Z'),
      artifactVersion: 'v1',
      lastEventTxHash: '0xcreate',
      lastEventLogIndex: 0,
      createdEventTxHash: '0xcreate',
      createdEventLogIndex: 0,
      actionCount: 2,
    };
  }

  function makeAction(index: number, checksum: string) {
    return {
      id: `a-${index}`,
      chainId: CHAIN_ID,
      proposalId: PROPOSAL_ID,
      actionIndex: index,
      target: '0x2222222222222222222222222222222222222222',
      valueWei: '0',
      calldata: `0x${index}`,
      selector: '0x12345678',
      functionSignature: 'transfer(address,uint256)',
      selectorUnknown: false,
      decodedArgs: null,
      calldataChecksum: checksum,
      artifactVersion: 'v1',
    };
  }

  it('reads proposal and actions inside one REPEATABLE READ transaction', async () => {
    const txRunner = makeSnapshotRunner(
      [makeProposal()],
      [makeAction(0, 'a'.repeat(64)), makeAction(1, 'b'.repeat(64))],
    );

    const result = await makeService(txRunner).getProposal(
      CHAIN_ID,
      PROPOSAL_ID,
    );

    expect(txRunner.run).toHaveBeenCalledTimes(1);
    expect(txRunner.isolationLevels).toEqual(['REPEATABLE READ']);
    expect(result.actions).toHaveLength(2);
  });

  it('never exposes a partially replaced action set committed during the read', async () => {
    const actionRows = [
      makeAction(0, 'a'.repeat(64)),
      makeAction(1, 'b'.repeat(64)),
    ];
    // Simulate the projector deleting the old actions and inserting only the
    // first replacement while this request is between its two reads.
    const txRunner = makeSnapshotRunner([makeProposal()], actionRows, () => {
      actionRows.splice(0, actionRows.length, makeAction(0, 'c'.repeat(64)));
    });

    const result = await makeService(txRunner).getProposal(
      CHAIN_ID,
      PROPOSAL_ID,
    );

    expect(result.actions.map((a) => a.calldata)).toEqual(['0x0', '0x1']);
    expect(result.actions.map((a) => a.calldataChecksum)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });
});
