import { NotFoundException } from '@nestjs/common';
import { GovernanceReadService } from '../governance-read.service';
import { ProposalChainState } from '../entities/governance-proposal.entity';
import { GOVERNOR_PROPOSAL_HASH_SCHEME } from '../proposal-decoder.service';

describe('GovernanceReadService', () => {
  const row = {
    chainId: 11155420,
    proposalId: '42',
    governorAddress: '0x0000000000000000000000000000000000001001',
    proposer: '0x1111111111111111111111111111111111111111',
    proposalHash:
      '0x6895777ff29ba155114db677f30190d21212a7c0bc8454c022c61179309eabe3',
    descriptionHash: '0x' + 'ab'.repeat(32),
    proposalHashScheme: GOVERNOR_PROPOSAL_HASH_SCHEME,
    description: 'test proposal',
    state: ProposalChainState.PENDING,
    eta: null,
    stateChangedAtBlock: '100',
    stateChangedAt: new Date('2026-01-01T00:00:00Z'),
    artifactVersion: 'v1',
    lastEventTxHash: '0xabc',
    lastEventLogIndex: 0,
  };

  function makeService(found: unknown) {
    const proposals = { findOne: jest.fn(async () => found) };
    const actions = { find: jest.fn(async () => []) };
    const votes = { find: jest.fn(async () => []) };
    const roleChanges = { find: jest.fn(async () => []) };
    return new GovernanceReadService(
      proposals as any,
      actions as any,
      votes as any,
      roleChanges as any,
    );
  }

  it('exposes the computed proposal hash and the description hash as distinct fields', async () => {
    const service = makeService(row);

    const result = await service.getProposal(11155420, '42');

    expect(result.proposalHash).toBe(row.proposalHash);
    expect(result.descriptionHash).toBe(row.descriptionHash);
    expect(result.proposalHashScheme).toBe(GOVERNOR_PROPOSAL_HASH_SCHEME);
    expect(result.proposalHash).not.toBe(result.descriptionHash);
  });

  it('still returns 404 for an unknown proposal', async () => {
    const service = makeService(null);
    await expect(service.getProposal(11155420, '42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
