import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Interface } from 'ethers';
import * as crypto from 'crypto';
import {
  DisputeEvidenceService,
  CanonicalEventRef,
} from './canonical-dispute-evidence.service';
import { ArtifactRegistryService } from '../v2/events/artifact-registry.service';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { DisputeOutcome } from './entities/dispute.entity';

const CHALLENGER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEPLOYMENT = '0xcccccccccccccccccccccccccccccccccccccccc';
const CLAIM = '0x' + 'a'.repeat(64);
const ROUND = '0x' + 'b'.repeat(64);
const TX = '0x' + 'd'.repeat(64);
const FINALIZED_HASH = '0x' + 'e'.repeat(64);
const ABI = [
  'event DisputeRaised(bytes32 indexed claimId, bytes32 indexed roundId, address challenger, uint256 bondAmount, address bondAsset, uint256 deadline)',
  'event DisputeResolved(bytes32 indexed claimId, bytes32 indexed roundId, bytes32 outcome, uint256 finalConfidence)',
  'event DisputeExpired(bytes32 indexed claimId, bytes32 indexed roundId)',
];
const IFACE = new Interface(ABI);
const EVENT_REF: CanonicalEventRef = { chainId: 10, txHash: TX, logIndex: 2 };

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    chainId: 10,
    contractAddress: DEPLOYMENT,
    artifactVersion: 'dispute-v1',
    eventName: 'DisputeResolved',
    txHash: TX,
    logIndex: 2,
    blockNumber: '100',
    blockTimestamp: new Date('2026-01-01T00:00:00Z'),
    claimId: CLAIM,
    roundId: ROUND,
    actor: CHALLENGER,
    payload: {
      claimId: CLAIM,
      roundId: ROUND,
      challenger: CHALLENGER,
      outcome: DisputeOutcome.OVERTURNED,
      finalConfidence: '0.85',
      bondAsset: DEPLOYMENT,
      bondAmount: '1000000000000000000',
    },
    rawArgs: {},
    ...overrides,
  } as CanonicalEvent;
}

describe('DisputeEvidenceService — canonical evidence gate', () => {
  let service: DisputeEvidenceService;
  let events: { findOne: jest.Mock };
  let artifacts: { findOne: jest.Mock };
  let checkpoints: { findOne: jest.Mock };
  let registry: { resolve: jest.Mock };
  let approvedArtifact: any;

  beforeEach(async () => {
    approvedArtifact = {
      chainId: 10,
      contractAddress: DEPLOYMENT.toLowerCase(),
      artifactVersion: 'dispute-v1',
      abiChecksum: crypto
        .createHash('sha256')
        .update(JSON.stringify(ABI))
        .digest('hex'),
      abi: ABI,
      isApproved: true,
      deploymentBlock: '90',
    };
    events = {
      findOne: jest.fn().mockImplementation(async () => makeEvent()),
    };
    artifacts = {
      findOne: jest.fn().mockResolvedValue(approvedArtifact),
    };
    checkpoints = {
      findOne: jest.fn().mockResolvedValue({
        chainId: 10,
        contractAddress: DEPLOYMENT.toLowerCase(),
        lastSafeBlock: '200',
        lastFinalizedBlock: '150',
        lastFinalizedBlockHash: FINALIZED_HASH,
      }),
    };
    registry = {
      resolve: jest
        .fn()
        .mockResolvedValue({ artifactVersion: 'dispute-v1', iface: IFACE }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeEvidenceService,
        { provide: getRepositoryToken(CanonicalEvent), useValue: events },
        { provide: getRepositoryToken(ContractArtifact), useValue: artifacts },
        { provide: getRepositoryToken(EventCheckpoint), useValue: checkpoints },
        { provide: ArtifactRegistryService, useValue: registry },
      ],
    }).compile();

    service = module.get(DisputeEvidenceService);
  });

  it('derives terminal outcome, confidence and full provenance from a finalized log', async () => {
    const evidence = await service.assertDisputeTerminal(
      EVENT_REF,
      CLAIM,
      ROUND,
    );
    expect(evidence).toMatchObject({
      chainId: 10,
      deploymentAddress: DEPLOYMENT.toLowerCase(),
      artifactVersion: 'dispute-v1',
      blockNumber: '100',
      txHash: TX,
      logIndex: 2,
      claimId: CLAIM,
      roundId: ROUND,
      terminalEventName: 'DisputeResolved',
      outcome: DisputeOutcome.OVERTURNED,
      finalConfidence: 0.85,
    });
    expect(evidence.occurredAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('derives DisputeExpired without inventing an outcome or confidence', async () => {
    events.findOne.mockImplementation(async () =>
      makeEvent({
        eventName: 'DisputeExpired',
        payload: { claimId: CLAIM, roundId: ROUND },
      }),
    );
    const evidence = await service.assertDisputeTerminal(
      EVENT_REF,
      CLAIM,
      ROUND,
    );
    expect(evidence.terminalEventName).toBe('DisputeExpired');
    expect(evidence.outcome).toBeNull();
    expect(evidence.finalConfidence).toBeNull();
  });

  it('binds a DisputeRaised actor to the verified principal', async () => {
    events.findOne.mockImplementation(async () =>
      makeEvent({
        eventName: 'DisputeRaised',
        payload: {
          claimId: CLAIM,
          roundId: ROUND,
          challenger: CHALLENGER,
          trigger: 'LOW_CONFIDENCE',
          originalConfidence: '0.4',
          bondAsset: DEPLOYMENT,
          bondAmount: '1000',
        },
      }),
    );
    const evidence = await service.assertDisputeRaised(
      EVENT_REF,
      '0x' + CHALLENGER.slice(2).toUpperCase(),
    );
    expect(evidence.challenger).toBe(CHALLENGER);
    expect(evidence.claimId).toBe(CLAIM);
    expect(evidence.roundId).toBe(ROUND);
    expect(evidence.trigger).toBe('LOW_CONFIDENCE');
    expect(evidence.reportedConfidence).toBe(0.4);

    await expect(service.assertDisputeRaised(EVENT_REF, OTHER)).rejects.toThrow(
      'CHALLENGER_MISMATCH',
    );
  });

  it('rejects wrong-chain, reorged and unexpected event identities', async () => {
    await expect(
      service.assertDisputeTerminal({ ...EVENT_REF, chainId: 1 }, CLAIM, ROUND),
    ).rejects.toThrow('WRONG_CHAIN');

    events.findOne.mockResolvedValue(null);
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('CANONICAL_EVENT_NOT_FOUND');

    events.findOne.mockImplementation(async () =>
      makeEvent({ eventName: 'DisputeRaised' }),
    );
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('UNEXPECTED_TERMINAL_EVENT');
  });

  it('rejects unfinalized events and a missing finalized block hash', async () => {
    const checkpoint = await checkpoints.findOne();
    checkpoints.findOne.mockResolvedValue({
      ...checkpoint,
      lastFinalizedBlock: '50',
    });
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('EVENT_NOT_FINALIZED');

    checkpoints.findOne.mockResolvedValue({
      ...checkpoint,
      lastFinalizedBlockHash: null,
    });
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('FINALIZED_BLOCK_HASH_MISSING');
  });

  it('rejects unapproved deployments, artifact drift and unknown schemas', async () => {
    artifacts.findOne.mockResolvedValue(null);
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('UNAPPROVED_DEPLOYMENT');

    artifacts.findOne.mockResolvedValue(approvedArtifact);
    registry.resolve.mockResolvedValue({
      artifactVersion: 'dispute-v2',
      iface: IFACE,
    });
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('ARTIFACT_DRIFT');

    registry.resolve.mockResolvedValue({
      artifactVersion: 'dispute-v1',
      iface: new Interface(['event SomethingElse(uint256 x)']),
    });
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('UNSUPPORTED_EVENT_SCHEMA');
  });

  it('rejects pre-deployment events', async () => {
    artifacts.findOne.mockResolvedValue({
      ...approvedArtifact,
      deploymentBlock: '120',
    });
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('PRE_DEPLOYMENT_EVENT');
  });

  it('rejects a terminal event bound to a different dispute', async () => {
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, '0x' + 'f'.repeat(64)),
    ).rejects.toThrow('DISPUTE_MISMATCH');
  });

  it('rejects an invalid outcome or confidence from a canonical payload', async () => {
    events.findOne.mockImplementation(async () =>
      makeEvent({
        payload: { claimId: CLAIM, roundId: ROUND, outcome: 'MAYBE' },
      }),
    );
    await expect(
      service.assertDisputeTerminal(EVENT_REF, CLAIM, ROUND),
    ).rejects.toThrow('INVALID_DISPUTE_OUTCOME');

    events.findOne.mockImplementation(async () =>
      makeEvent({
        payload: {
          claimId: CLAIM,
          roundId: ROUND,
          outcome: DisputeOutcome.CONFIRMED,
          finalConfidence: '0.99',
        },
      }),
    );
    const evidence = await service.assertDisputeTerminal(
      EVENT_REF,
      CLAIM,
      ROUND,
    );
    expect(evidence.finalConfidence).toBe(0.99);
  });
});
