import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import {
  ChainArtifactAuthority,
  ClaimAccuracyProvenance,
} from './sybil-resistance.types';

export const CANONICAL_CLAIM_ACCURACY_SOURCE = {
  chainId: 11155420,
  releaseId: 'rel-opsepolia-20261015-v2',
  artifactVersion: '2.0.0-rc.3',
  artifactHash:
    'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
  deploymentBlock: 24850000,
  claimRegistryAddress: '0x0000000000000000000000000000000000001001',
  verificationEngineAddress: '0x0000000000000000000000000000000000001002',
} as const;

const ACCURACY_EVENT_NAMES = [
  'ClaimSubmitted',
  'VerificationRecorded',
  'VerdictSettled',
  'DisputeRaised',
  'DisputeResolved',
  'DisputeExpired',
];

const DISPUTE_EVENT_NAMES = new Set([
  'DisputeRaised',
  'DisputeResolved',
  'DisputeExpired',
]);

const CHAIN_LABELS: Record<number, string[]> = {
  10: ['optimism', 'optimism-mainnet', 'optimism mainnet', 'op-mainnet', '10'],
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
  artifactVersion?: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: bigint | number | string;
  blockTimestamp?: Date | null;
  actor?: string | null;
  claimId?: string | null;
  roundId?: string | null;
  blockHash?: string | null;
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
  deploymentBlock?: number;
  orphanedBlockHashes?: string[];
  checkpointObservedAt?: Date | null;
}

interface OrderedEvent {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
}

interface Settlement extends OrderedEvent {
  outcome: boolean | null;
}

interface DisputeState extends OrderedEvent {
  status: 'raised' | 'resolved' | 'expired';
  flipOutcome: boolean;
  replacementOutcome: boolean | null;
  outcomeKnown: boolean;
}

interface Evaluation extends OrderedEvent {
  actor: string;
  claimId: string;
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

function readString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
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
  return left.txHash.toLowerCase().localeCompare(right.txHash.toLowerCase());
}

function toAccuracyEvent(event: CanonicalEvent): AccuracyEvent {
  const payload =
    event.payload && typeof event.payload === 'object' ? event.payload : {};
  return {
    eventName: event.eventName,
    chainId: event.chainId,
    contractAddress: event.contractAddress,
    artifactVersion: event.artifactVersion,
    txHash: event.txHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    blockTimestamp: event.blockTimestamp ?? null,
    actor: event.actor ?? null,
    claimId: event.claimId ?? null,
    roundId: event.roundId ?? null,
    payload,
  };
}

function acceptedContract(eventName: string, address: string): boolean {
  const normalized = normalizeAddress(address);
  const source = CANONICAL_CLAIM_ACCURACY_SOURCE;
  if (eventName === 'ClaimSubmitted') {
    return normalized === source.claimRegistryAddress;
  }
  if (eventName === 'VerificationRecorded' || eventName === 'VerdictSettled') {
    return normalized === source.verificationEngineAddress;
  }
  return (
    DISPUTE_EVENT_NAMES.has(eventName) &&
    (normalized === source.claimRegistryAddress ||
      normalized === source.verificationEngineAddress)
  );
}

function unavailableResult(reason: string): ClaimAccuracyResult {
  return {
    claimsVotedOn: 0,
    claimsCorrect: 0,
    observedAt: null,
    provenance: {
      status: 'unavailable',
      source: 'canonical_events',
      observedAt: null,
      canonicalEventCount: 0,
      eligibleEvaluationCount: 0,
      exclusions: {},
      reason,
    },
  };
}

export function projectClaimAccuracy(
  input: ClaimAccuracyProjectionInput,
): ClaimAccuracyResult {
  const { authority, events, wallets } = input;
  const source = CANONICAL_CLAIM_ACCURACY_SOURCE;
  const deploymentBlock = BigInt(
    input.deploymentBlock ?? source.deploymentBlock,
  );
  const finalizedThroughBlock = BigInt(
    Math.min(authority.finalizedThroughBlock, input.finalizedThroughBlock),
  );
  const exclusions: Record<string, number> = {
    duplicateEvents: 0,
    invalidProvenance: 0,
    reorgedEvents: 0,
    crossChainWallet: 0,
    unknownClaimAuthor: 0,
    ownClaim: 0,
    unsettled: 0,
    disputed: 0,
    disputedOutcomeUnknown: 0,
    abstention: 0,
    unknownOutcome: 0,
    conflictingEvaluation: 0,
  };

  const orphaned = new Set(
    (input.orphanedBlockHashes ?? []).map((hash) => hash.toLowerCase()),
  );
  const eligibleWallets = new Set<string>();
  const chainLabels = CHAIN_LABELS[authority.chainId] ?? [];
  for (const wallet of wallets) {
    const address = normalizeAddress(wallet.address);
    if (!address) continue;
    const walletChain = (wallet.chain ?? '').trim().toLowerCase();
    if (
      walletChain &&
      chainLabels.length > 0 &&
      !chainLabels.includes(walletChain)
    ) {
      exclusions.crossChainWallet += 1;
      continue;
    }
    eligibleWallets.add(address);
  }

  const seenLogs = new Set<string>();
  const accepted: Array<AccuracyEvent & OrderedEvent> = [];
  for (const raw of events) {
    const blockNumber = parseBlockNumber(raw.blockNumber);
    const txHash = normalizeAddress(raw.txHash);
    const blockHash = normalizeAddress(
      raw.blockHash ?? readString(raw.payload ?? {}, ['blockHash']),
    );
    const key = `${raw.chainId}:${txHash}:${raw.logIndex}`;
    if (seenLogs.has(key)) {
      exclusions.duplicateEvents += 1;
      continue;
    }
    seenLogs.add(key);
    if (blockHash && orphaned.has(blockHash)) {
      exclusions.reorgedEvents += 1;
      continue;
    }
    if (
      blockNumber === null ||
      raw.chainId !== authority.chainId ||
      raw.chainId !== source.chainId ||
      !/^0x[a-fA-F0-9]{64}$/.test(raw.txHash) ||
      !Number.isInteger(raw.logIndex) ||
      raw.logIndex < 0 ||
      blockNumber < deploymentBlock ||
      blockNumber > finalizedThroughBlock ||
      !acceptedContract(raw.eventName, raw.contractAddress) ||
      !raw.claimId ||
      (raw.artifactVersion &&
        raw.artifactVersion !== source.releaseId &&
        raw.artifactVersion !== source.artifactVersion)
    ) {
      exclusions.invalidProvenance += 1;
      continue;
    }
    accepted.push({
      ...raw,
      blockNumber,
      txHash,
      blockHash,
    });
  }
  accepted.sort(compareOrder);

  const claimAuthors = new Map<string, string>();
  const ambiguousAuthors = new Set<string>();
  const settlements = new Map<string, Settlement>();
  const disputes = new Map<string, DisputeState>();
  const evaluations: Evaluation[] = [];
  let latestObservedAt: Date | null = null;

  for (const event of accepted) {
    if (event.blockTimestamp instanceof Date) {
      if (!latestObservedAt || event.blockTimestamp > latestObservedAt) {
        latestObservedAt = event.blockTimestamp;
      }
    }

    if (event.eventName === 'ClaimSubmitted') {
      const author = normalizeAddress(
        event.actor ?? readString(event.payload, ['author', 'submitter']),
      );
      const previous = claimAuthors.get(event.claimId!);
      if (!author || (previous && previous !== author)) {
        ambiguousAuthors.add(event.claimId!);
      } else if (!previous) {
        claimAuthors.set(event.claimId!, author);
      }
      continue;
    }

    if (event.eventName === 'VerdictSettled') {
      const settlement: Settlement = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        txHash: event.txHash,
        outcome: parseVerdict(
          event.payload.finalVerdict ??
            event.payload.verdict ??
            event.payload.outcome,
        ),
      };
      const previous = settlements.get(event.claimId!);
      if (!previous || compareOrder(settlement, previous) > 0) {
        settlements.set(event.claimId!, settlement);
      }
      continue;
    }

    if (DISPUTE_EVENT_NAMES.has(event.eventName)) {
      const outcomeRaw =
        event.eventName === 'DisputeResolved'
          ? readString(event.payload, ['outcome', 'resolvedOutcome'])
          : null;
      const outcome = parseVerdict(outcomeRaw);
      const isOverturned = outcomeRaw
        ? ['overturned', 'overturned_verdict'].includes(
            outcomeRaw.trim().toLowerCase(),
          )
        : false;
      const isUpheld = outcomeRaw
        ? ['upheld', 'upheld_verdict'].includes(outcomeRaw.trim().toLowerCase())
        : false;
      const dispute: DisputeState = {
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        txHash: event.txHash,
        status:
          event.eventName === 'DisputeRaised'
            ? 'raised'
            : event.eventName === 'DisputeExpired'
              ? 'expired'
              : 'resolved',
        flipOutcome: isOverturned,
        replacementOutcome: outcome,
        outcomeKnown: isOverturned || isUpheld || outcome !== null,
      };
      const previous = disputes.get(event.claimId!);
      if (!previous || compareOrder(dispute, previous) > 0) {
        disputes.set(event.claimId!, dispute);
      }
      continue;
    }

    if (event.eventName === 'VerificationRecorded') {
      const actor = normalizeAddress(event.actor);
      if (!eligibleWallets.has(actor)) continue;
      evaluations.push({
        blockNumber: event.blockNumber,
        logIndex: event.logIndex,
        txHash: event.txHash,
        actor,
        claimId: event.claimId!,
        verdict: parseVerdict(
          event.payload.verdict ??
            event.payload.position ??
            event.payload.verdictValue,
        ),
        timestamp: event.blockTimestamp ?? null,
      });
    }
  }

  const grouped = new Map<string, Evaluation[]>();
  for (const evaluation of evaluations) {
    const key = `${evaluation.claimId}:${evaluation.actor}`;
    const group = grouped.get(key) ?? [];
    group.push(evaluation);
    grouped.set(key, group);
  }

  let claimsVotedOn = 0;
  let claimsCorrect = 0;
  let countedObservedAt: Date | null = null;

  for (const group of grouped.values()) {
    const verdicts = new Set(
      group.map((item) =>
        item.verdict === null ? 'abstain' : String(item.verdict),
      ),
    );
    if (verdicts.size > 1) {
      exclusions.conflictingEvaluation += 1;
      continue;
    }
    const evaluation = [...group].sort(compareOrder)[0];
    if (evaluation.verdict === null) {
      exclusions.abstention += 1;
      continue;
    }

    const author = claimAuthors.get(evaluation.claimId);
    if (!author || ambiguousAuthors.has(evaluation.claimId)) {
      exclusions.unknownClaimAuthor += 1;
      continue;
    }
    if (author === evaluation.actor) {
      exclusions.ownClaim += 1;
      continue;
    }

    const settlement = settlements.get(evaluation.claimId);
    if (!settlement) {
      exclusions.unsettled += 1;
      continue;
    }

    const dispute = disputes.get(evaluation.claimId);
    if (dispute?.status === 'raised') {
      exclusions.disputed += 1;
      continue;
    }
    if (dispute?.status === 'resolved' && !dispute.outcomeKnown) {
      exclusions.disputedOutcomeUnknown += 1;
      continue;
    }

    let outcome = settlement.outcome;
    if (dispute?.status === 'resolved') {
      if (dispute.flipOutcome && outcome !== null) {
        outcome = !outcome;
      } else if (dispute.replacementOutcome !== null) {
        outcome = dispute.replacementOutcome;
      }
    }
    if (outcome === null) {
      exclusions.unknownOutcome += 1;
      continue;
    }

    claimsVotedOn += 1;
    if (evaluation.verdict === outcome) claimsCorrect += 1;
    if (
      evaluation.timestamp &&
      (!countedObservedAt || evaluation.timestamp > countedObservedAt)
    ) {
      countedObservedAt = evaluation.timestamp;
    }
  }

  const observedAt =
    countedObservedAt ?? latestObservedAt ?? input.checkpointObservedAt ?? null;

  return {
    claimsVotedOn,
    claimsCorrect,
    observedAt,
    provenance: {
      status: 'finalized',
      source: 'canonical_events',
      chainId: authority.chainId,
      releaseId: authority.releaseId,
      contractAddress: source.verificationEngineAddress,
      finalizedThroughBlock: Number(finalizedThroughBlock),
      observedAt: observedAt ? observedAt.toISOString() : null,
      canonicalEventCount: accepted.length,
      eligibleEvaluationCount: claimsVotedOn,
      exclusions,
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
    const source = CANONICAL_CLAIM_ACCURACY_SOURCE;
    if (
      authority &&
      (authority.chainId !== source.chainId ||
        authority.releaseId !== source.releaseId ||
        authority.artifactHash.toLowerCase() !==
          source.artifactHash.toLowerCase())
    ) {
      return unavailableResult('authority-mismatch');
    }

    let checkpoint: EventCheckpoint | null;
    try {
      checkpoint = await this.checkpoints.findOne({
        where: {
          chainId: source.chainId,
          contractAddress: source.verificationEngineAddress,
        },
        order: { updatedAt: 'DESC' },
      });
    } catch (error) {
      this.logger.warn(
        `Claim accuracy checkpoint unavailable: ${String(error)}`,
      );
      return unavailableResult('checkpoint-unavailable');
    }
    if (!checkpoint) {
      return unavailableResult('checkpoint-missing');
    }

    const checkpointBlock = parseBlockNumber(checkpoint.lastFinalizedBlock);
    if (checkpointBlock === null) {
      return unavailableResult('checkpoint-invalid');
    }
    const finalizedThroughBlock = Math.min(
      authority?.finalizedThroughBlock ?? Number(checkpointBlock),
      Number(checkpointBlock),
    );
    if (
      !Number.isSafeInteger(finalizedThroughBlock) ||
      finalizedThroughBlock < source.deploymentBlock
    ) {
      return unavailableResult('finalized-block-invalid');
    }

    let rows: CanonicalEvent[];
    try {
      rows = await this.events
        .createQueryBuilder('e')
        .where('e.chainId = :chainId', { chainId: source.chainId })
        .andWhere('e.eventName IN (:...eventNames)', {
          eventNames: ACCURACY_EVENT_NAMES,
        })
        .andWhere('CAST(e.blockNumber AS NUMERIC) >= :deploymentBlock', {
          deploymentBlock: String(source.deploymentBlock),
        })
        .andWhere('CAST(e.blockNumber AS NUMERIC) <= :finalizedBlock', {
          finalizedBlock: String(finalizedThroughBlock),
        })
        .orderBy('e.blockNumber', 'ASC')
        .addOrderBy('e.logIndex', 'ASC')
        .getMany();
    } catch (error) {
      this.logger.warn(`Claim accuracy history unavailable: ${String(error)}`);
      return unavailableResult('history-unavailable');
    }

    const effectiveAuthority: ChainArtifactAuthority = authority ?? {
      chainId: source.chainId,
      releaseId: source.releaseId,
      artifactHash: source.artifactHash,
      contractAddress: source.verificationEngineAddress,
      finalizedThroughBlock,
    };

    return projectClaimAccuracy({
      events: rows.map(toAccuracyEvent),
      wallets,
      authority: effectiveAuthority,
      finalizedThroughBlock,
      checkpointObservedAt: checkpoint.updatedAt ?? null,
    });
  }
}
