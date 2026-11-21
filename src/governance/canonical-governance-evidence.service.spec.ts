import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Interface } from 'ethers';
import * as crypto from 'crypto';
import {
  GovernanceEvidenceService,
  CanonicalEventRef,
} from './canonical-governance-evidence.service';
import { ArtifactRegistryService } from '../v2/events/artifact-registry.service';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';

const VOTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GOVERNOR = '0xcccccccccccccccccccccccccccccccccccccccc';
const TX = '0x' + 'd'.repeat(64);
const FINALIZED_HASH = '0x' + 'e'.repeat(64);
const ABI = [
  'event ProposalCreated(uint256 proposalId,address proposer)',
  'event VoteCast(address voter,uint256 proposalId,uint8 support,uint256 weight)',
];
const IFACE = new Interface(ABI);
const EVENT_REF: CanonicalEventRef = { chainId: 10, txHash: TX, logIndex: 2 };

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    chainId: 10,
    contractAddress: GOVERNOR,
    artifactVersion: 'governor-v1',
    eventName: 'VoteCast',
    txHash: TX,
    logIndex: 2,
    blockNumber: '100',
    payload: {
      voter: VOTER,
      proposalId: '42',
      support: '1',
      weight: '123456789012345678901234567890',
    },
    rawArgs: {},
    ...overrides,
  } as CanonicalEvent;
}

describe('GovernanceEvidenceService — canonical evidence gate', () => {
  let service: GovernanceEvidenceService;
  let events: { findOne: jest.Mock };
  let artifacts: { findOne: jest.Mock };
  let checkpoints: { findOne: jest.Mock };
  let registry: { resolve: jest.Mock };

  beforeEach(async () => {
    events = {
      findOne: jest.fn().mockImplementation(async () => makeEvent()),
    };
    artifacts = {
      findOne: jest.fn().mockResolvedValue({
        chainId: 10,
        contractAddress: GOVERNOR.toLowerCase(),
        artifactVersion: 'governor-v1',
        abiChecksum: crypto
          .createHash('sha256')
          .update(JSON.stringify(ABI))
          .digest('hex'),
        abi: ABI,
        isApproved: true,
        deploymentBlock: '90',
      }),
    };
    checkpoints = {
      findOne: jest.fn().mockResolvedValue({
        chainId: 10,
        contractAddress: GOVERNOR.toLowerCase(),
        lastSafeBlock: '200',
        lastFinalizedBlock: '150',
        lastFinalizedBlockHash: FINALIZED_HASH,
      }),
    };
    registry = {
      resolve: jest
        .fn()
        .mockResolvedValue({ artifactVersion: 'governor-v1', iface: IFACE }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceEvidenceService,
        { provide: getRepositoryToken(CanonicalEvent), useValue: events },
        { provide: getRepositoryToken(ContractArtifact), useValue: artifacts },
        { provide: getRepositoryToken(EventCheckpoint), useValue: checkpoints },
        { provide: ArtifactRegistryService, useValue: registry },
      ],
    }).compile();

    service = module.get(GovernanceEvidenceService);
  });

  it('derives voter, support and exact weight from the canonical event', async () => {
    const evidence = await service.assertVoteCast(EVENT_REF, VOTER, '42');
    expect(evidence).toMatchObject({
      chainId: 10,
      governorAddress: GOVERNOR.toLowerCase(),
      proposalId: '42',
      voter: VOTER,
      support: true,
      supportMode: 'FOR',
      weight: '123456789012345678901234567890',
      txHash: TX,
      logIndex: 2,
      blockNumber: '100',
    });
  });

  it('maps ABSTAIN support without inventing a weight', async () => {
    events.findOne.mockResolvedValue(
      makeEvent({
        payload: { voter: VOTER, proposalId: '42', support: '2', weight: '7' },
      }),
    );
    const evidence = await service.assertVoteCast(EVENT_REF, VOTER, '42');
    expect(evidence.supportMode).toBe('ABSTAIN');
    expect(evidence.support).toBe(false);
    expect(evidence.weight).toBe('7');
  });

  it('rejects non-finalized events', async () => {
    checkpoints.findOne.mockResolvedValue({
      ...(await checkpoints.findOne()),
      lastFinalizedBlock: '50',
    });
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '42'),
    ).rejects.toThrow('EVENT_NOT_FINALIZED');
  });

  it('rejects a missing finalized block hash (fail closed)', async () => {
    checkpoints.findOne.mockResolvedValue({
      chainId: 10,
      contractAddress: GOVERNOR.toLowerCase(),
      lastSafeBlock: '200',
      lastFinalizedBlock: '150',
      lastFinalizedBlockHash: null,
    });
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '42'),
    ).rejects.toThrow('FINALIZED_BLOCK_HASH_MISSING');
  });

  it('rejects wrong-chain and reorged (missing) events deterministically', async () => {
    await expect(
      service.assertVoteCast({ ...EVENT_REF, chainId: 1 }, VOTER, '42'),
    ).rejects.toThrow('WRONG_CHAIN');

    events.findOne.mockResolvedValue(null);
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '42'),
    ).rejects.toThrow('CANONICAL_EVENT_NOT_FOUND');
  });

  it('rejects unapproved deployments and artifact drift', async () => {
    artifacts.findOne.mockResolvedValue(null);
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '42'),
    ).rejects.toThrow('UNAPPROVED_DEPLOYMENT');

    artifacts.findOne.mockResolvedValue({
      contractAddress: GOVERNOR,
      isApproved: true,
      deploymentBlock: '90',
    });
    registry.resolve.mockResolvedValue({
      artifactVersion: 'governor-v2',
      iface: IFACE,
    });
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '42'),
    ).rejects.toThrow('ARTIFACT_DRIFT');
  });

  it('rejects pre-deployment events', async () => {
    artifacts.findOne.mockResolvedValue({
      contractAddress: GOVERNOR,
      isApproved: true,
      deploymentBlock: '120',
    });
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '42'),
    ).rejects.toThrow('PRE_DEPLOYMENT_EVENT');
  });

  it('rejects a foreign voter and a mismatched proposal id', async () => {
    await expect(
      service.assertVoteCast(EVENT_REF, OTHER, '42'),
    ).rejects.toThrow('VOTER_MISMATCH');
    await expect(
      service.assertVoteCast(EVENT_REF, VOTER, '43'),
    ).rejects.toThrow('PROPOSAL_MISMATCH');
  });

  it('binds ProposalCreated to the verified proposer', async () => {
    events.findOne.mockResolvedValue(
      makeEvent({
        eventName: 'ProposalCreated',
        payload: { proposalId: '42', proposer: VOTER },
      }),
    );
    const evidence = await service.assertProposalCreated(EVENT_REF, VOTER);
    expect(evidence).toMatchObject({
      proposalId: '42',
      proposer: VOTER,
      chainId: 10,
      governorAddress: GOVERNOR.toLowerCase(),
    });

    await expect(
      service.assertProposalCreated(EVENT_REF, OTHER),
    ).rejects.toThrow('PROPOSER_MISMATCH');
  });
});
