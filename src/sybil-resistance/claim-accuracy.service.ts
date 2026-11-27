import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import {
  ChainArtifactAuthority,
  ClaimAccuracyProvenance,
} from './sybil-resistance.types';

export const CANONICAL_CLAIM_ACCURACY_BINDING = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  artifactHash:
    'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
  deploymentBlock: 24850000,
  claimRegistryAddress: '0x0000000000000000000000000000000000001001',
  verificationEngineAddress: '0x0000000000000000000000000000000000001002',
  evidenceRegistryAddress: '0x0000000000000000000000000000000000001003',
  stakingTokenAddress: '0x0000000000000000000000000000000000001004',
} as const;

const RELEVANT_EVENT_NAMES = [
  'ClaimSubmitted',
  'VerificationRecorded',
  'VerdictSettled',
  'VerificationRoundOpened',
  'DisputeRaised',
  'DisputeResolved',
  'DisputeExpired',
];

const DISPUTE_EVENT_NAMES = new Set([
  'DisputeRaised',
  'DisputeResolved',
  'DisputeExpired',
]);

const CHAIN_NAMES: Record<number, string[]> = {
  10: ['optimism', 'optimism-mainnet', 'optimism mainnet', '10'],
  11155420: [
    'optimism-sepolia',
    'optimism_sepolia',
    'optimism sepolia',
    'op-sepolia',
    '11155420',
  ],
};

export interface AccuracyEvent {
  eventName: string;
  chainId: number;
  contractAddress: string;
  artifactVersion: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTimestamp: Date | null;
  actor: string | null;
  claimId: string | null;
  roundId: string | null;
  payload: Record<string, unknown>;
}

export interface AccuracyWallet {
  address?: string;
  chain?: string;
  linkedAt?: Date;
}

export interface ClaimAccuracyResult {
  claimsVotedOn: number;
  claimsCorrect: number;
  observedAt: Date | null;
  provenance: ClaimAccuracyProvenance;
}

export interface ClaimAccuracyProjectionInput {
  events: AccuracyEvent[];
  wallets: AccuracyWallet[];
  authority: ChainArtifactAuthority;
  finalizedThroughBlock: number;
  deploymentBlock: number;
  checkpointObservedAt?: Date | null;
}

interface OrderedEvent {
  blockNumber: bigint;
  logIndex: number;
}

interface Settlement extends OrderedEvent {
  outcome: boolean | null;
}

interface DisputeState extends OrderedEvent {
  status: 'raised' | 'resolved' | 'expired';
  outcomeRaw: string | null;
}

interface Candidate extends OrderedEvent {
  actor: string;
  claimId: string;
  roundId: string | null;
  verdict: boolean | null;
  timestamp: Date | null;
}

function normalizeAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseBlockNumber(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function readPayloadString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'boolean') return String(value);
  }
  return null;
}

function parseVerdict(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (
    value === 'true' ||
    value === '1' ||
    value === 'support' ||
    value === 'supported' ||
    /^0x0*1$/.test(value)
  ) {
    return true;
  }
  if (
    value === 'false' ||
    value === '0' ||
    value === 'oppose' ||
    value === 'opposed' ||
    /^0x0*0$/.test(value)
  ) {
    return false;
  }
  return null;
}

function compareOrder(left: OrderedEvent, right: OrderedEvent): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber > right.blockNumber ? 1 : -1;
  }
  if (left.logIndex !== right.logIndex) {
    return left.logIndex > right.logIndex ? 1 : -1;
  }
  return 0;
}

function toAccuracyEvent(event: CanonicalEvent): AccuracyEvent {
  const blockNumber = parseBlockNumber(event.blockNumber) ?? 0n;
  const payload =
    event.payload && typeof event.payload === 'object' ? event.payload : {};

  return {
    eventName: event.eventName,
    chainId: event.chainId,
    contractAddress: event.contractAddress,
    artifactVersion: event.artifactVersion,
    txHash: event.txHash,
    logIndex: event.logIndex,
    blockNumber,
    blockTimestamp: event.blockTimestamp ?? null,
    actor: event.actor ?? null,
    claimId: event.claimId ?? null,
    roundId: event.roundId ?? null,
    payload,
  };
}

function expectedContract(eventName: string, address: string): boolean {
  const normalized = normalizeAddress(address);
  const binding = CANONICAL_CLAIM_ACCURACY_BINDING;
  const canonicalAddresses: string[] = [
    binding.claimRegistryAddress,
    binding.verificationEngineAddress,
    binding.evidenceRegistryAddress,
    binding.stakingTokenAddress,
  ];

  if (eventName === 'ClaimSubmitted') {
    return normalized === binding.claimRegistryAddress;
  }
  if (
    eventName === 'VerificationRecorded' ||
    eventName === 'VerdictSettled' ||
    eventName === 'VerificationRoundOpened'
  ) {
    return normalized === binding.verificationEngineAddress;
  }
  if (DISPUTE_EVENT_NAMES.has(eventName)) {
    return canonicalAddresses.includes(normalized);
  }
  return false;
}

function isValidEvent(
  event: AccuracyEvent,
  authority: ChainArtifactAuthority,
  finalizedThroughBlock: number,
  deploymentBlock: number,
): boolean {
  if (event.chainId !== authority.chainId) return false;
  if (!/^0x[a-fA-F0-9]{64}$/.test(event.txHash)) return false;
  if (!Number.isInteger(event.logIndex) || event.logIndex < 0) return false;
  if (!expectedContract(event.eventName, event.contractAddress)) return false;
  if (event.blockNumber < BigInt(deploymentBlock)) return false;
  if (event.blockNumber > BigInt(finalizedThroughBlock)) return false;

  if (!event.claimId && !event.roundId) return false;

  return true;
}

function unavailableResult(reason: string): ClaimAccuracyResult {
  return {
    claimsVotedOn: 0,
    claimsCorrect: 0,
    observedAt: null,
    provenance: {
      status: 'unavailable',
      observedAt: null,
      canonicalEventCount: 0,
      eligibleEvaluationCount: 0,
      excluded: {},
      reason,
    },
  };
}

/**
 * Deterministic, read-only projection of finalized canonical claim-history
 * events into the two accuracy counters consumed by the Sybil model.
 */
export function projectClaimAccuracy(
  input: ClaimAccuracyProjectionInput,
): ClaimAccuracyResult {
  const { authority, deploymentBlock, events } = input;
  const finalizedThroughBlock = Math.min(
    authority.finalizedThroughBlock,
    input.finalizedThroughBlock,
  );
  const excluded: Record<string, number> = {
    duplicateEvents: 0,
    invalidProvenance: 0,
    crossChainWallet: 0,
    unverifiedClaimAuthor: 0,
    ownClaim: 0,
    unsettled: 0,
    disputed: 0,
    abstention: 0,
    unknownOutcome: 0,
    conflictingDuplicate: 0,
  };

  const eligibleAddresses = new Set<string>();
  const chainNames = CHAIN_NAMES[authority.chainId] ?? [];
  for (const wallet of input.wallets) {
    if (!wallet.address) continue;
    const normalized = normalizeAddress(wallet.address);
    if (!normalized) continue;
    const walletChain = (wallet.chain ?? '').trim().toLowerCase();
    if (chainNames.length > 0 && !chainNames.includes(walletChain)) {
      excluded.crossChainWallet += 1;
      continue;
    }
    eligibleAddresses.add(normalized);
  }

  const seenLogs = new Set<string>();
  const accepted: AccuracyEvent[] = [];
  for (const event of events) {
    const key = `${event.chainId}:${normalizeAddress(event.txHash)}:${event.logIndex}`;
    if (seenLogs.has(key)) {
      excluded.duplicateEvents += 1;
      continue;
    }
    seenLogs.add(key);
    if (
      !isValidEvent(event, authority, finalizedThroughBlock, deploymentBlock)
    ) {
      excluded.invalidProvenance += 1;
      continue;
    }
    accepted.push(event);
  }

  const ordered = [...accepted].sort(compareOrder);
  const claimAuthors = new Map<string, string>();
  const ambiguousClaims = new Set<string>();
  const roundClaims = new Map<string, string>();
  const settlements = new Map<string, Settlement>();
  const disputes = new Map<string, DisputeState>();
  const candidates: Candidate[] = [];
  let latestTimestamp: Date | null = null;

  for (const event of ordered) {
    if (event.blockTimestamp instanceof Date) {
      if (!latestTimestamp || event.blockTimestamp > latestTimestamp) {
        latestTimestamp = event.blockTimestamp;
      }
    }

    if (event.eventName === 'ClaimSubmitted' && event.claimId) {
      const author = normalizeAddress(
        event.actor ??
          readPayloadString(event.payload, ['author', 'submitter']),
      );
      const previous = claimAuthors.get(event.claimId);
      if (!author || (previous && previous !== author)) {
        ambiguousClaims.add(event.claimId);
      } else if (!previous) {
        claimAuthors.set(event.claimId, author);
      }
      continue;
    }

    if (event.eventName === 'VerificationRoundOpened') {
      if (event.claimId && event.roundId) {
        const previous = roundClaims.get(event.roundId);
        if (previous && previous !== event.claimId) {
          ambiguousClaims.add(event.claimId);
        } else {
          roundClaims.set(event.roundId, event.claimId);
        }
      }
      continue;
    }

    if (event.eventName === 'VerdictSettled' && event.claimId) {
      const settlement: Settlement = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        outcome: parseVerdict(
          event.payload.finalVerdict ??
            event.payload.verdict ??
            event.payload.outcome,
        ),
      };
      const previous = settlements.get(event.claimId);
      if (!previous || compareOrder(settlement, previous) > 0) {
        settlements.set(event.claimId, settlement);
      }
      continue;
    }

    if (DISPUTE_EVENT_NAMES.has(event.eventName)) {
      const claimId =
        event.claimId ??
        (event.roundId ? roundClaims.get(event.roundId) : null);
      if (!claimId) continue;
      const status: DisputeState['status'] =
        event.eventName === 'DisputeRaised'
          ? 'raised'
          : event.eventName === 'DisputeExpired'
            ? 'expired'
            : 'resolved';
      const dispute: DisputeState = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        status,
        outcomeRaw:
          status === 'resolved'
            ? readPayloadString(event.payload, ['outcome', 'resolvedOutcome'])
            : null,
      };
      const previous = disputes.get(claimId);
      if (!previous || compareOrder(dispute, previous) > 0) {
        disputes.set(claimId, dispute);
      }
      continue;
    }

    if (event.eventName === 'VerificationRecorded') {
      if (!event.claimId || !event.actor) continue;
      const actor = normalizeAddress(event.actor);
      if (!eligibleAddresses.has(actor)) continue;
      candidates.push({
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        actor,
        claimId: event.claimId,
        roundId: event.roundId ?? null,
        verdict: parseVerdict(
          event.payload.verdict ??
            event.payload.position ??
            event.payload.verdictValue,
        ),
        timestamp: event.blockTimestamp ?? null,
      });
    }
  }

  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.claimId}:${candidate.actor}:${candidate.roundId ?? ''}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }

  let claimsVotedOn = 0;
  let claimsCorrect = 0;
  let latestCountedTimestamp: Date | null = null;

  for (const group of grouped.values()) {
    const verdicts = new Set(
      group.map((candidate) =>
        candidate.verdict === null ? 'abstain' : String(candidate.verdict),
      ),
    );
    if (verdicts.size > 1) {
      excluded.conflictingDuplicate += 1;
      continue;
    }

    const candidate = [...group].sort(compareOrder)[0];
    if (candidate.verdict === null) {
      excluded.abstention += 1;
      continue;
    }

    const author = claimAuthors.get(candidate.claimId);
    if (!author || ambiguousClaims.has(candidate.claimId)) {
      excluded.unverifiedClaimAuthor += 1;
      continue;
    }
    if (author === candidate.actor) {
      excluded.ownClaim += 1;
      continue;
    }

    const settlement = settlements.get(candidate.claimId);
    if (!settlement) {
      excluded.unsettled += 1;
      continue;
    }

    const dispute = disputes.get(candidate.claimId);
    if (dispute?.status === 'raised') {
      excluded.disputed += 1;
      continue;
    }

    let outcome = settlement.outcome;
    if (dispute?.status === 'resolved') {
      const raw = (dispute.outcomeRaw ?? '').trim().toLowerCase();
      if (raw === 'overturned' || raw === 'overturned_verdict') {
        outcome = outcome === null ? null : !outcome;
      } else if (raw !== 'upheld' && raw !== 'upheld_verdict') {
        outcome = parseVerdict(raw);
      }
    }

    if (outcome === null) {
      excluded.unknownOutcome += 1;
      continue;
    }

    claimsVotedOn += 1;
    if (candidate.verdict === outcome) claimsCorrect += 1;
    if (candidate.timestamp instanceof Date) {
      if (
        !latestCountedTimestamp ||
        candidate.timestamp > latestCountedTimestamp
      ) {
        latestCountedTimestamp = candidate.timestamp;
      }
    }
  }

  const observedAt =
    latestCountedTimestamp ??
    latestTimestamp ??
    input.checkpointObservedAt ??
    null;

  return {
    claimsVotedOn,
    claimsCorrect,
    observedAt,
    provenance: {
      status: 'finalized',
      chainId: authority.chainId,
      releaseId: authority.releaseId,
      verificationContractAddress: authority.contractAddress,
      finalizedThroughBlock,
      observedAt: observedAt ? observedAt.toISOString() : null,
      canonicalEventCount: ordered.length,
      eligibleEvaluationCount: claimsVotedOn,
      excluded,
    },
  };
}

@Injectable()
export class ClaimAccuracyService {
  private readonly logger = new Logger(ClaimAccuracyService.name);

  constructor(
    @InjectRepository(CanonicalEvent)
    private readonly events: Repository<CanonicalEvent>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpoints: Repository<EventCheckpoint>,
  ) {}

  async deriveAccuracy(
    wallets: AccuracyWallet[],
    authority?: ChainArtifactAuthority,
  ): Promise<ClaimAccuracyResult> {
    const binding = CANONICAL_CLAIM_ACCURACY_BINDING;

    let resolvedAuthority: ChainArtifactAuthority | undefined = authority;
    let checkpoint: EventCheckpoint;

    if (resolvedAuthority) {
      let found: EventCheckpoint | null;
      try {
        found = await this.checkpoints.findOne({
          where: {
            chainId: resolvedAuthority.chainId,
            contractAddress: resolvedAuthority.contractAddress,
          },
          order: { updatedAt: 'DESC' },
        });
      } catch (error) {
        this.logger.warn(
          `Canonical claim accuracy checkpoint unavailable: ${String(error)}`,
        );
        return unavailableResult('checkpoint-unavailable');
      }
      if (!found) {
        return unavailableResult('checkpoint-missing');
      }
      checkpoint = found;
    } else {
      let found: EventCheckpoint | null;
      try {
        found = await this.checkpoints.findOne({
          where: {
            chainId: binding.chainId,
            contractAddress: binding.verificationEngineAddress,
          },
          order: { updatedAt: 'DESC' },
        });
      } catch (error) {
        this.logger.warn(
          `Canonical claim accuracy checkpoint unavailable: ${String(error)}`,
        );
        return unavailableResult('checkpoint-unavailable');
      }
      if (!found) {
        return unavailableResult('checkpoint-missing');
      }
      checkpoint = found;
      const finalized = parseBlockNumber(checkpoint.lastFinalizedBlock);
      if (finalized === null) {
        return unavailableResult('checkpoint-invalid');
      }
      resolvedAuthority = {
        chainId: binding.chainId,
        releaseId: binding.releaseId,
        artifactHash: binding.artifactHash,
        contractAddress: binding.verificationEngineAddress,
        finalizedThroughBlock: Number(finalized),
      };
    }

    const finalizedFromCheckpoint = parseBlockNumber(
      checkpoint.lastFinalizedBlock,
    );
    if (finalizedFromCheckpoint === null) {
      return unavailableResult('checkpoint-invalid');
    }

    const finalizedThroughBlock = Math.min(
      resolvedAuthority.finalizedThroughBlock,
      Number(finalizedFromCheckpoint),
    );
    if (
      !Number.isSafeInteger(finalizedThroughBlock) ||
      finalizedThroughBlock < 0
    ) {
      return unavailableResult('finalized-block-invalid');
    }

    const deploymentBlock =
      resolvedAuthority.chainId === binding.chainId
        ? binding.deploymentBlock
        : 0;

    let rows: CanonicalEvent[];
    try {
      rows = await this.events
        .createQueryBuilder('e')
        .where('e.chainId = :chainId', { chainId: resolvedAuthority.chainId })
        .andWhere('e.eventName IN (:...eventNames)', {
          eventNames: RELEVANT_EVENT_NAMES,
        })
        .andWhere('CAST(e.blockNumber AS NUMERIC) >= :deploymentBlock', {
          deploymentBlock: String(deploymentBlock),
        })
        .andWhere('CAST(e.blockNumber AS NUMERIC) <= :finalizedBlock', {
          finalizedBlock: String(finalizedThroughBlock),
        })
        .orderBy('e.blockNumber', 'ASC')
        .addOrderBy('e.logIndex', 'ASC')
        .getMany();
    } catch (error) {
      this.logger.warn(
        `Canonical claim accuracy history unavailable: ${String(error)}`,
      );
      return unavailableResult('history-unavailable');
    }

    return projectClaimAccuracy({
      events: rows.map(toAccuracyEvent),
      wallets,
      authority: resolvedAuthority,
      finalizedThroughBlock,
      deploymentBlock,
      checkpointObservedAt: checkpoint.updatedAt ?? null,
    });
  }
}
