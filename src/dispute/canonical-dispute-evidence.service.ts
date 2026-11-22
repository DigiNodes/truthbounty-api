import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventFragment } from 'ethers';
import { DisputeOutcome, DisputeTrigger } from './entities/dispute.entity';
import { ArtifactRegistryService } from '../v2/events/artifact-registry.service';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';

/** Optimism mainnet / Sepolia — the only sanctioned dispute deployments. */
export const DISPUTE_CHAIN_IDS = [10, 11155420] as const;
export const DISPUTE_RAISED_EVENT = 'DisputeRaised';
export const DISPUTE_RESOLVED_EVENT = 'DisputeResolved';
export const DISPUTE_EXPIRED_EVENT = 'DisputeExpired';
export const DISPUTE_TERMINAL_EVENTS = [
  DISPUTE_RESOLVED_EVENT,
  DISPUTE_EXPIRED_EVENT,
] as const;

export interface CanonicalEventRef {
  chainId: number;
  txHash: string;
  logIndex: number;
}

export interface CanonicalDisputeRaisedEvidence {
  chainId: number;
  deploymentAddress: string;
  artifactVersion: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
  occurredAt: Date | null;
  claimId: string;
  roundId: string;
  challenger: string;
  bondAsset: string | null;
  bondAmount: string | null;
  trigger: DisputeTrigger;
  reportedConfidence: number | null;
}

export interface CanonicalDisputeTerminalEvidence {
  chainId: number;
  deploymentAddress: string;
  artifactVersion: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
  occurredAt: Date | null;
  claimId: string;
  roundId: string;
  terminalEventName: (typeof DISPUTE_TERMINAL_EVENTS)[number];
  outcome: DisputeOutcome | null;
  finalConfidence: number | null;
}

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

/**
 * Server-side authority for legacy dispute outcomes.
 *
 * An HTTP caller supplies only the identity of a canonical log
 * (chainId + txHash + logIndex). Every protocol-authoritative field —
 * terminal status, outcome, confidence, actor, claim/round binding and
 * provenance — is re-derived here from a canonical event that was decoded
 * under an approved, checksum-verified release artifact and covered by a
 * finalized deployment checkpoint. Anything else fails closed with a stable
 * machine-readable code.
 */
@Injectable()
export class DisputeEvidenceService {
  private readonly logger = new Logger(DisputeEvidenceService.name);

  constructor(
    @InjectRepository(CanonicalEvent)
    private readonly events: Repository<CanonicalEvent>,
    @InjectRepository(ContractArtifact)
    private readonly artifacts: Repository<ContractArtifact>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpoints: Repository<EventCheckpoint>,
    private readonly artifactRegistry: ArtifactRegistryService,
  ) {}

  /** Resolve and verify a DisputeRaised event; bind the actor to the JWT. */
  async assertDisputeRaised(
    ref: CanonicalEventRef,
    principalAddress: string,
  ): Promise<CanonicalDisputeRaisedEvidence> {
    const { event, provenance } = await this.resolveCanonicalEvent(
      ref,
      DISPUTE_RAISED_EVENT,
    );
    const payload = this.payloadOf(event);

    const claimId = this.readIdentifier(payload.claimId) ?? event.claimId;
    const roundId = this.readIdentifier(payload.roundId) ?? event.roundId;
    const challenger = this.normalizeAddress(payload.challenger ?? event.actor);
    if (!claimId || !roundId || !challenger) {
      this.reject('INVALID_DISPUTE_RAISED_PAYLOAD');
    }
    if (challenger !== this.normalizeAddress(principalAddress)) {
      this.reject('CHALLENGER_MISMATCH');
    }

    return {
      ...provenance,
      occurredAt: event.blockTimestamp ?? null,
      claimId,
      roundId,
      challenger,
      bondAsset: this.normalizeAddress(payload.bondAsset) ?? event.asset,
      bondAmount: this.normalizeDecimal(payload.bondAmount) ?? event.amount,
      trigger: this.readTrigger(payload.trigger),
      reportedConfidence: this.readUnitInterval(payload.originalConfidence),
    };
  }

  /** Resolve and verify a terminal event for an already-bound dispute. */
  async assertDisputeTerminal(
    ref: CanonicalEventRef,
    expectedClaimId: string,
    expectedRoundId: string,
  ): Promise<CanonicalDisputeTerminalEvidence> {
    const chainId = ref?.chainId;
    const txHash =
      typeof ref?.txHash === 'string' ? ref.txHash.toLowerCase() : '';
    const logIndex = ref?.logIndex;
    if (
      !Number.isInteger(logIndex) ||
      logIndex < 0 ||
      !TX_HASH_PATTERN.test(txHash)
    ) {
      this.reject('INVALID_EVENT_REFERENCE');
    }

    const candidate = await this.events.findOne({
      where: { chainId, txHash, logIndex },
    });
    if (!candidate) {
      this.reject('CANONICAL_EVENT_NOT_FOUND');
    }
    const expectedName = DISPUTE_TERMINAL_EVENTS.find(
      (name) => name === candidate.eventName,
    );
    if (!expectedName) {
      this.reject('UNEXPECTED_TERMINAL_EVENT');
    }

    const { event, provenance } = await this.resolveCanonicalEvent(
      ref,
      expectedName,
    );
    const payload = this.payloadOf(event);

    const claimId = this.readIdentifier(payload.claimId) ?? event.claimId;
    const roundId = this.readIdentifier(payload.roundId) ?? event.roundId;
    if (
      !claimId ||
      !roundId ||
      claimId !== expectedClaimId ||
      roundId !== expectedRoundId
    ) {
      this.reject('DISPUTE_MISMATCH');
    }

    let outcome: DisputeOutcome | null = null;
    let finalConfidence: number | null = null;
    if (expectedName === DISPUTE_RESOLVED_EVENT) {
      outcome = this.readOutcome(payload.outcome);
      if (!outcome) {
        this.reject('INVALID_DISPUTE_OUTCOME');
      }
      finalConfidence = this.readUnitInterval(payload.finalConfidence);
    }

    return {
      ...provenance,
      occurredAt: event.blockTimestamp ?? null,
      claimId,
      roundId,
      terminalEventName: expectedName,
      outcome,
      finalConfidence,
    };
  }

  /**
   * Common fail-closed gate: canonical log identity, approved chain and
   * deployment, release artifact version, deployment height and finality.
   */
  private async resolveCanonicalEvent(
    ref: CanonicalEventRef,
    expectedEventName: string,
  ): Promise<{
    event: CanonicalEvent;
    provenance: {
      chainId: number;
      deploymentAddress: string;
      artifactVersion: string;
      blockNumber: string;
      txHash: string;
      logIndex: number;
    };
  }> {
    const chainId = ref?.chainId;
    const txHash =
      typeof ref?.txHash === 'string' ? ref.txHash.toLowerCase() : '';
    const logIndex = ref?.logIndex;

    if (
      !Number.isInteger(chainId) ||
      !DISPUTE_CHAIN_IDS.includes(chainId as (typeof DISPUTE_CHAIN_IDS)[number])
    ) {
      this.reject('WRONG_CHAIN');
    }
    if (!TX_HASH_PATTERN.test(txHash)) {
      this.reject('INVALID_EVENT_REFERENCE');
    }
    if (!Number.isInteger(logIndex) || logIndex < 0) {
      this.reject('INVALID_EVENT_REFERENCE');
    }

    const event = await this.events.findOne({
      where: { chainId, txHash, logIndex },
    });
    if (!event) {
      this.reject('CANONICAL_EVENT_NOT_FOUND');
    }
    if (event.eventName !== expectedEventName) {
      this.reject('UNEXPECTED_EVENT_NAME');
    }

    const deploymentAddress = event.contractAddress.toLowerCase();
    const artifact = await this.artifacts.findOne({
      where: { chainId, contractAddress: deploymentAddress, isApproved: true },
    });
    if (!artifact) {
      this.reject('UNAPPROVED_DEPLOYMENT');
    }

    const resolved = await this.artifactRegistry.resolve(
      chainId,
      deploymentAddress,
    );
    if (!resolved || resolved.artifactVersion !== event.artifactVersion) {
      this.reject('ARTIFACT_DRIFT');
    }
    if (
      !resolved.iface.fragments.some(
        (fragment) =>
          fragment instanceof EventFragment &&
          fragment.name === expectedEventName,
      )
    ) {
      this.reject('UNSUPPORTED_EVENT_SCHEMA');
    }
    if (
      artifact.deploymentBlock !== null &&
      BigInt(event.blockNumber) < BigInt(artifact.deploymentBlock)
    ) {
      this.reject('PRE_DEPLOYMENT_EVENT');
    }

    const checkpoint = await this.checkpoints.findOne({
      where: { chainId, contractAddress: deploymentAddress },
    });
    if (!checkpoint) {
      this.reject('FINALIZED_CHECKPOINT_MISSING');
    }
    const finalizedBlock = BigInt(checkpoint.lastFinalizedBlock ?? '0');
    if (finalizedBlock <= 0n || BigInt(event.blockNumber) > finalizedBlock) {
      this.reject('EVENT_NOT_FINALIZED');
    }
    if (!TX_HASH_PATTERN.test(checkpoint.lastFinalizedBlockHash ?? '')) {
      this.reject('FINALIZED_BLOCK_HASH_MISSING');
    }

    return {
      event,
      provenance: {
        chainId: event.chainId,
        deploymentAddress,
        artifactVersion: event.artifactVersion,
        blockNumber: event.blockNumber,
        txHash: event.txHash.toLowerCase(),
        logIndex: event.logIndex,
      },
    };
  }

  private payloadOf(event: CanonicalEvent): Record<string, unknown> {
    return { ...(event.rawArgs ?? {}), ...(event.payload ?? {}) };
  }

  private normalizeAddress(value: unknown): string | null {
    if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
      return null;
    }
    return value.toLowerCase();
  }

  private readIdentifier(value: unknown): string | null {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'bigint' || typeof value === 'number') {
      return value.toString();
    }
    return null;
  }

  private normalizeDecimal(value: unknown): string | null {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint'
    ) {
      return null;
    }
    try {
      const asBigInt = BigInt(value);
      return asBigInt >= 0n ? asBigInt.toString() : null;
    } catch {
      return null;
    }
  }

  private readUnitInterval(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const asNumber = Number(value);
    if (
      !Number.isFinite(asNumber) ||
      asNumber < 0 ||
      asNumber > 1 ||
      String(value).trim() === ''
    ) {
      return null;
    }
    return asNumber;
  }

  private readOutcome(value: unknown): DisputeOutcome | null {
    if (value === DisputeOutcome.CONFIRMED) return DisputeOutcome.CONFIRMED;
    if (value === DisputeOutcome.OVERTURNED) return DisputeOutcome.OVERTURNED;
    return null;
  }

  private readTrigger(value: unknown): DisputeTrigger {
    if (value === DisputeTrigger.LOW_CONFIDENCE) {
      return DisputeTrigger.LOW_CONFIDENCE;
    }
    if (value === DisputeTrigger.MINORITY_OPPOSITION) {
      return DisputeTrigger.MINORITY_OPPOSITION;
    }
    return DisputeTrigger.MANUAL;
  }

  private reject(code: string): never {
    this.logger.warn(`Rejected dispute evidence: ${code}`);
    throw new BadRequestException(code);
  }
}
