import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventFragment } from 'ethers';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEvent } from '../v2/events/entities/canonical-event.entity';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { ArtifactRegistryService } from '../v2/events/artifact-registry.service';

export const GOVERNANCE_CHAIN_IDS = [10, 11155420] as const;
export const PROPOSAL_CREATED_EVENT = 'ProposalCreated';
export const VOTE_CAST_EVENT = 'VoteCast';

export interface CanonicalEventRef {
  chainId: number;
  txHash: string;
  logIndex: number;
}

export interface CanonicalProposalEvidence {
  chainId: number;
  governorAddress: string;
  proposalId: string;
  proposer: string;
  artifactVersion: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
}

export interface CanonicalVoteEvidence {
  chainId: number;
  governorAddress: string;
  proposalId: string;
  voter: string;
  support: boolean;
  supportMode: 'FOR' | 'AGAINST' | 'ABSTAIN';
  weight: string;
  artifactVersion: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
}

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

/**
 * Server-side authority for governance records.
 *
 * The HTTP client never supplies an address, a weight, or "proof" that an
 * on-chain action happened. It supplies only the identity of a canonical log
 * (chainId + txHash + logIndex). Every field that ends up in a governance row
 * is then re-derived here from a canonical event that was decoded under an
 * approved, checksum-verified deployment artifact and covered by a finalized
 * checkpoint. Anything else fails closed with a stable machine-readable code.
 */
@Injectable()
export class GovernanceEvidenceService {
  private readonly logger = new Logger(GovernanceEvidenceService.name);

  constructor(
    @InjectRepository(CanonicalEvent)
    private readonly events: Repository<CanonicalEvent>,
    @InjectRepository(ContractArtifact)
    private readonly artifacts: Repository<ContractArtifact>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpoints: Repository<EventCheckpoint>,
    private readonly artifactRegistry: ArtifactRegistryService,
  ) {}

  async assertProposalCreated(
    ref: CanonicalEventRef,
    principalAddress: string,
  ): Promise<CanonicalProposalEvidence> {
    const { event, resolved } = await this.resolveCanonicalEvent(
      ref,
      PROPOSAL_CREATED_EVENT,
    );
    const payload = this.payloadOf(event);

    const proposalId = this.readDecimal(payload, 'proposalId');
    const proposer = this.readAddress(payload, 'proposer');
    if (!proposalId || !proposer) {
      this.reject('INVALID_PROPOSAL_CREATED_PAYLOAD');
    }
    if (proposer !== this.normalizeAddress(principalAddress)) {
      this.reject('PROPOSER_MISMATCH');
    }

    return {
      chainId: event.chainId,
      governorAddress: event.contractAddress.toLowerCase(),
      proposalId,
      proposer,
      artifactVersion: resolved.artifactVersion,
      blockNumber: event.blockNumber,
      txHash: event.txHash.toLowerCase(),
      logIndex: event.logIndex,
    };
  }

  async assertVoteCast(
    ref: CanonicalEventRef,
    principalAddress: string,
    expectedProposalId: string,
  ): Promise<CanonicalVoteEvidence> {
    const { event, resolved } = await this.resolveCanonicalEvent(
      ref,
      VOTE_CAST_EVENT,
    );
    const payload = this.payloadOf(event);

    const proposalId = this.readDecimal(payload, 'proposalId');
    if (
      !proposalId ||
      proposalId !== this.normalizeDecimal(expectedProposalId)
    ) {
      this.reject('PROPOSAL_MISMATCH');
    }

    const voter = this.readAddress(payload, 'voter');
    if (!voter) {
      this.reject('INVALID_VOTE_PAYLOAD');
    }
    if (voter !== this.normalizeAddress(principalAddress)) {
      this.reject('VOTER_MISMATCH');
    }

    const supportMode = this.readSupport(payload.support);
    const weight = this.readWeight(payload.weight);
    if (!supportMode || weight === null) {
      this.reject('INVALID_VOTE_PAYLOAD');
    }

    return {
      chainId: event.chainId,
      governorAddress: event.contractAddress.toLowerCase(),
      proposalId,
      voter,
      support: supportMode === 'FOR',
      supportMode,
      weight,
      artifactVersion: resolved.artifactVersion,
      blockNumber: event.blockNumber,
      txHash: event.txHash.toLowerCase(),
      logIndex: event.logIndex,
    };
  }

  /**
   * Common fail-closed gate: canonical log identity, approved chain and
   * deployment, artifact version, deployment height and finality checkpoint.
   */
  private async resolveCanonicalEvent(
    ref: CanonicalEventRef,
    expectedEventName: string,
  ): Promise<{
    event: CanonicalEvent;
    resolved: { artifactVersion: string };
  }> {
    const chainId = ref?.chainId;
    const txHash =
      typeof ref?.txHash === 'string' ? ref.txHash.toLowerCase() : '';
    const logIndex = ref?.logIndex;

    if (
      !Number.isInteger(chainId) ||
      !GOVERNANCE_CHAIN_IDS.includes(
        chainId as (typeof GOVERNANCE_CHAIN_IDS)[number],
      )
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

    const contractAddress = event.contractAddress.toLowerCase();
    const artifact = await this.artifacts.findOne({
      where: { chainId, contractAddress, isApproved: true },
    });
    if (!artifact) {
      this.reject('UNAPPROVED_DEPLOYMENT');
    }

    const resolved = await this.artifactRegistry.resolve(
      chainId,
      contractAddress,
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
      where: { chainId, contractAddress },
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

    return { event, resolved };
  }

  private payloadOf(event: CanonicalEvent): Record<string, unknown> {
    const payload = event.payload ?? {};
    const rawArgs = event.rawArgs ?? {};
    return { ...rawArgs, ...payload };
  }

  private normalizeAddress(value: unknown): string | null {
    if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
      return null;
    }
    return value.toLowerCase();
  }

  private readAddress(
    payload: Record<string, unknown>,
    key: string,
  ): string | null {
    return this.normalizeAddress(payload[key]);
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

  private readDecimal(
    payload: Record<string, unknown>,
    key: string,
  ): string | null {
    return this.normalizeDecimal(payload[key]);
  }

  private readWeight(value: unknown): string | null {
    return this.normalizeDecimal(value);
  }

  private readSupport(
    value: unknown,
  ): CanonicalVoteEvidence['supportMode'] | null {
    if (
      value === true ||
      value === 'true' ||
      value === 1 ||
      value === 1n ||
      value === '1'
    ) {
      return 'FOR';
    }
    if (
      value === false ||
      value === 'false' ||
      value === 0 ||
      value === 0n ||
      value === '0'
    ) {
      return 'AGAINST';
    }
    if (value === 2 || value === 2n || value === '2') {
      return 'ABSTAIN';
    }
    return null;
  }

  private reject(code: string): never {
    this.logger.warn(`Rejected governance evidence: ${code}`);
    throw new BadRequestException(code);
  }
}
